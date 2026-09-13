#!/usr/bin/env python3
"""Generate the chapter narration for the Trebuchet product walkthrough."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import torch
import torchaudio as ta
from chatterbox.tts import ChatterboxTTS


NARRATION = [
    {
        "id": "intro",
        "start_ms": 300,
        "text": "Trebuchet turns a Solana token launch into a guarded, local, verifiable operation.",
    },
    {
        "id": "guided-practice",
        "event": "chapter-01",
        "offset_ms": 2500,
        "text": (
            "Start in Practice. Name the token, add its ticker and artwork, choose where every "
            "remaining asset returns, then set the target value and liquidity budget. Practice "
            "runs the complete recipe locally: token creation, authority removal, liquidity, locks, "
            "final return, and proof, without spending Sol or sending a transaction."
        ),
    },
    {
        "id": "wallet-custody",
        "event": "chapter-02",
        "offset_ms": 800,
        "text": (
            "Trebuchet signs through an isolated app-managed wallet. Your personal wallet only funds "
            "the launch and receives the final sweep. Launch secrets stay encrypted on this Mac."
        ),
    },
    {
        "id": "advanced-phases",
        "event": "chapter-03",
        "offset_ms": 900,
        "text": (
            "Advanced mode exposes six guarded phases: choose the signer; design the token and markets; "
            "estimate, fund, and verify the launch wallet; create the token and revoke authorities; "
            "create and lock liquidity; then distribute, sweep, and save proof. Irreversible actions "
            "remain blocked until the required custody, funding, destination, and chain evidence are real."
        ),
    },
    {
        "id": "token-discovery",
        "event": "chapter-04",
        "offset_ms": 900,
        "text": (
            "Discovery begins with wallets you know, including Trebuchet-managed wallets. It builds a "
            "private on-chain graph, presents a scrollable token feed, and separates market movement "
            "from chain safety, holder concentration, and evidence confidence."
        ),
    },
    {
        "id": "recovery-history",
        "event": "chapter-05",
        "offset_ms": 800,
        "text": (
            "History is also recovery. Journals show completed operations, unfinished wallets, audit "
            "evidence, and the next safe action, so an interrupted launch resumes from checkpoints "
            "instead of repeating work."
        ),
    },
    {
        "id": "runtime-settings",
        "event": "chapter-06",
        "offset_ms": 800,
        "text": (
            "Settings keep execution policy, R P C health, local security, release trust, and reporting "
            "visible. Practice and live stay distinct."
        ),
    },
    {
        "id": "cli-boundary",
        "event": "chapter-07",
        "offset_ms": 700,
        "text": (
            "The C L I builds and verifies deterministic plans, estimates funding, and validates proof. "
            "Wallet custody and execution remain inside the guarded Mac O S application."
        ),
    },
    {
        "id": "outro",
        "event": "outro",
        "offset_ms": 0,
        "text": "One recipe. Six guarded phases. Local keys, explicit recovery, and proof at every step.",
    },
]


def load_timeline(path: Path) -> dict[str, int]:
    data = json.loads(path.read_text())
    return {event["id"]: int(event["startMs"]) for event in data["events"]}


def split_for_tts(text: str, max_words: int = 18) -> list[str]:
    """Keep Chatterbox generations short enough for stable Metal performance."""
    phrases = []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        clauses = re.split(r"(?<=[,;:])\s+", sentence)
        pending = ""
        for clause in clauses:
            candidate = f"{pending} {clause}".strip()
            if pending and len(candidate.split()) > max_words:
                phrases.append(pending)
                pending = clause
            else:
                pending = candidate
        if pending:
            words = pending.split()
            while len(words) > max_words:
                phrases.append(" ".join(words[:max_words]) + ".")
                words = words[max_words:]
            if words:
                phrases.append(" ".join(words))
    return phrases


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: generate-v2-walkthrough-voiceover.py OUTPUT_DIR", file=sys.stderr)
        return 2

    output_dir = Path(sys.argv[1]).resolve()
    timeline_path = output_dir / "TIMELINE.json"
    voice_dir = output_dir / "voiceover"
    voice_dir.mkdir(parents=True, exist_ok=True)
    timeline = load_timeline(timeline_path)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    original_torch_load = torch.load
    if device == "mps":
        def patched_torch_load(*args, **kwargs):
            kwargs["map_location"] = torch.device("mps")
            return original_torch_load(*args, **kwargs)
        torch.load = patched_torch_load

    print(f"Loading Chatterbox on {device}...", flush=True)
    model = ChatterboxTTS.from_pretrained(device=device)
    manifest = []

    for index, item in enumerate(NARRATION, start=1):
        torch.manual_seed(1700 + index)
        if "start_ms" in item:
            start_ms = int(item["start_ms"])
        else:
            start_ms = timeline[item["event"]] + int(item.get("offset_ms", 0))
        output_path = voice_dir / f"{index:02d}-{item['id']}.wav"
        phrases = split_for_tts(item["text"])
        print(f"[{index}/{len(NARRATION)}] {item['id']} ({len(phrases)} phrases)", flush=True)
        rendered = []
        for phrase_index, phrase in enumerate(phrases, start=1):
            torch.manual_seed(1700 + index * 10 + phrase_index)
            print(f"  phrase {phrase_index}/{len(phrases)}", flush=True)
            phrase_audio = model.generate(
                phrase,
                exaggeration=0.42,
                cfg_weight=0.45,
                temperature=0.72,
            )
            rendered.append(phrase_audio.detach().cpu())
            if phrase_index < len(phrases):
                rendered.append(torch.zeros((1, round(model.sr * 0.24))))
            del phrase_audio
            if device == "mps":
                torch.mps.empty_cache()
        waveform = torch.cat(rendered, dim=-1)
        ta.save(str(output_path), waveform.detach().cpu(), model.sr)
        duration_ms = round(waveform.shape[-1] * 1000 / model.sr)
        manifest.append({
            "id": item["id"],
            "path": str(output_path),
            "startMs": start_ms,
            "durationMs": duration_ms,
            "text": item["text"],
        })

    manifest_path = voice_dir / "manifest.json"
    manifest_path.write_text(json.dumps({
        "engine": "chatterbox-tts-0.1.7",
        "device": device,
        "segments": manifest,
    }, indent=2) + "\n")
    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
