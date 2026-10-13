#!/usr/bin/env python3
"""Transcribe one podcast episode with MLX Whisper and validate its coverage."""

import argparse
import json
import time
from pathlib import Path

import mlx.core as mx
import mlx_whisper


def timestamp(seconds):
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    secs, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


parser = argparse.ArgumentParser()
parser.add_argument("--audio", required=True)
parser.add_argument("--slug", required=True)
parser.add_argument("--title", required=True)
parser.add_argument("--expected-duration", required=True, type=float)
parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
parser.add_argument("--model")
args = parser.parse_args()

root = Path(args.root).resolve()
audio = Path(args.audio).resolve()
snapshot_root = root / ".cache" / "huggingface" / "hub" / "models--mlx-community--whisper-large-v3-turbo" / "snapshots"
local_snapshots = sorted(snapshot_root.iterdir()) if snapshot_root.exists() else []
model = args.model or (str(local_snapshots[-1]) if local_snapshots else "mlx-community/whisper-large-v3-turbo")
processing = root / "processing"
processing.mkdir(parents=True, exist_ok=True)
output_json = processing / f"{args.slug}.mlx.json"
output_srt = processing / f"{args.slug}.srt"
status_path = root / ".cache" / f"{args.slug}-status.json"
status_path.parent.mkdir(parents=True, exist_ok=True)

if output_json.exists() and output_srt.exists():
    existing = json.loads(output_json.read_text(encoding="utf-8"))
    segments = existing.get("segments", [])
    final_timestamp = float(segments[-1]["end"]) if segments else 0.0
    if final_timestamp >= args.expected_duration * 0.95:
        write_json(status_path, {
            "state": "validated_complete",
            "reused": True,
            "segments": len(segments),
            "final_timestamp": final_timestamp,
            "expected_duration": args.expected_duration,
            "srt": str(output_srt),
            "json": str(output_json),
        })
        print(json.dumps({"slug": args.slug, "state": "reused", "segments": len(segments)}))
        raise SystemExit(0)

prompt = (
    f"Podcast episode: {args.title}. A discussion about Magic: The Gathering. "
    "Use exact Magic card names and MTG terminology when spoken: Commander, EDH, Standard, "
    "Modern, Legacy, Pioneer, Pauper, Arena, Scryfall, mana value, color identity, legendary "
    "creature, command zone, instant, sorcery, artifact, enchantment, planeswalker, typal, "
    "tokens, counters, triggered ability, activated ability, Sol Ring, Command Tower, Arcane "
    "Signet, Rhystic Study."
)
started = time.time()
write_json(status_path, {
    "state": "transcribing",
    "started_at_epoch": started,
    "title": args.title,
    "model": model,
    "audio": str(audio),
    "expected_duration": args.expected_duration,
    "device": str(mx.default_device()),
})

try:
    result = mlx_whisper.transcribe(
        str(audio),
        path_or_hf_repo=model,
        language="en",
        task="transcribe",
        initial_prompt=prompt,
        condition_on_previous_text=False,
        word_timestamps=True,
        hallucination_silence_threshold=2.0,
        no_speech_threshold=0.6,
        logprob_threshold=-1.0,
        compression_ratio_threshold=2.4,
        temperature=(0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        best_of=5,
        verbose=False,
        fp16=True,
    )
    segments = []
    for source in result.get("segments", []):
        text = " ".join(str(source.get("text", "")).strip().split())
        if not text:
            continue
        words = [{
            "word": word.get("word", ""),
            "start": float(word.get("start", 0.0)),
            "end": float(word.get("end", 0.0)),
            "probability": float(word.get("probability", 0.0)),
        } for word in source.get("words", [])]
        segments.append({
            "id": int(source.get("id", len(segments))),
            "start": float(source["start"]),
            "end": float(source["end"]),
            "text": text,
            "temperature": float(source.get("temperature", 0.0)),
            "avg_logprob": float(source.get("avg_logprob", 0.0)),
            "compression_ratio": float(source.get("compression_ratio", 0.0)),
            "no_speech_prob": float(source.get("no_speech_prob", 0.0)),
            "words": words,
        })

    elapsed = time.time() - started
    final_timestamp = float(segments[-1]["end"]) if segments else 0.0
    monotonic = all(segment["start"] >= 0 and segment["end"] >= segment["start"] for segment in segments)
    complete = bool(segments) and monotonic and final_timestamp >= args.expected_duration * 0.95
    write_json(output_json, {
        "language": result.get("language", "en"),
        "model": model,
        "elapsed_seconds": elapsed,
        "settings": {
            "condition_on_previous_text": False,
            "word_timestamps": True,
            "initial_prompt": prompt,
        },
        "segments": segments,
    })
    blocks = [
        f"{index}\n{timestamp(segment['start'])} --> {timestamp(segment['end'])}\n{segment['text']}"
        for index, segment in enumerate(segments, start=1)
    ]
    output_srt.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")
    write_json(status_path, {
        "state": "validated_complete" if complete else "incomplete_needs_retry",
        "started_at_epoch": started,
        "completed_at_epoch": time.time(),
        "elapsed_seconds": elapsed,
        "segments": len(segments),
        "final_timestamp": final_timestamp,
        "expected_duration": args.expected_duration,
        "monotonic_timestamps": monotonic,
        "srt": str(output_srt),
        "json": str(output_json),
        "device": str(mx.default_device()),
    })
    print(json.dumps({
        "slug": args.slug,
        "state": "validated_complete" if complete else "incomplete_needs_retry",
        "segments": len(segments),
        "final_timestamp": final_timestamp,
        "elapsed_seconds": elapsed,
    }, indent=2))
    if not complete:
        raise SystemExit(2)
except BaseException as error:
    if not isinstance(error, SystemExit):
        write_json(status_path, {
            "state": "failed",
            "started_at_epoch": started,
            "failed_at_epoch": time.time(),
            "error": repr(error),
            "audio": str(audio),
        })
    raise
