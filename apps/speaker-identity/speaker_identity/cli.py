from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .audio import embedding_from_audio
from .store import SpeakerStore

DEFAULT_DATABASE = Path(".data/hablabla/speakers.sqlite3")
DEFAULT_MODEL = "pyannote/embedding"


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description="Local, consent-based Hablabla speaker profiles")
    command.add_argument("--database", type=Path, default=Path(os.environ.get("HABLABLA_SPEAKER_DB", DEFAULT_DATABASE)))
    subcommands = command.add_subparsers(dest="command", required=True)
    enroll = subcommands.add_parser("enroll", help="enroll a locally consented voice sample")
    enroll.add_argument("--name", required=True)
    enroll.add_argument("--audio", type=Path, required=True)
    enroll.add_argument("--model", default=DEFAULT_MODEL)
    enroll.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"))
    enroll.add_argument("--consent", action="store_true", help="confirms this person consented to local biometric enrollment")
    identify = subcommands.add_parser("identify", help="produce a tentative local match")
    identify.add_argument("--audio", type=Path, required=True)
    identify.add_argument("--model", default=DEFAULT_MODEL)
    identify.add_argument("--hf-token", default=os.environ.get("HF_TOKEN"))
    identify.add_argument("--threshold", type=float, default=0.78)
    identify.add_argument("--margin", type=float, default=0.05)
    subcommands.add_parser("list", help="list local profiles")
    delete = subcommands.add_parser("delete", help="permanently delete an enrolled profile and its embeddings")
    delete.add_argument("profile_id")
    return command


def main() -> None:
    args = parser().parse_args()
    with SpeakerStore(args.database) as store:
        if args.command == "list":
            print(json.dumps([profile.__dict__ for profile in store.list_profiles()], indent=2))
            return
        if args.command == "delete":
            if not store.delete(args.profile_id):
                raise SystemExit("Profile not found.")
            print("Deleted local speaker profile and every stored enrollment embedding.")
            return
        if args.command == "enroll" and not args.consent:
            raise SystemExit("Refusing enrollment: pass --consent only after the person has agreed.")
        embedding = embedding_from_audio(args.audio, args.hf_token)
        if args.command == "enroll":
            profile = store.enroll(args.name, embedding, args.model)
            print(json.dumps(profile.__dict__, indent=2))
            return
        match = store.identify(embedding, args.model, minimum_similarity=args.threshold, minimum_margin=args.margin)
        print(json.dumps({"profile": match.profile.__dict__ if match.profile else None, "similarity": match.similarity,
                          "second_best_similarity": match.second_best_similarity, "reason": match.reason}, indent=2))


if __name__ == "__main__":
    main()
