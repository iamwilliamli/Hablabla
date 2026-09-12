# Local speaker identity

This is a local, consent-based profile module for Hablabla. It turns a
single-speaker enrollment clip into a voice embedding, stores the embedding in
SQLite, and makes **tentative** matches against a later clip. It is not an
authentication system and must not silently name a person in the transcript.

## Privacy and data model

- The SQLite database stores normalized numeric embeddings, profile metadata,
  model ID, and enrollment timestamps. It never stores raw audio or a transcript.
- Enrollment is explicit (`--consent`), deletion is permanent, and a match must
  clear both a similarity threshold and a runner-up margin.
- Matches should be shown as “Possible: Name” and confirmed by a human. Never
  use a voice profile for login, authorization, or surveillance.
- Keep `.data/hablabla/speakers.sqlite3` out of Git and protect it like other
  biometric data. The default is relative to the current working directory;
  set `HABLABLA_SPEAKER_DB` to use an encrypted local volume instead.

## Install on the demo Mac

Python 3.10+ is required. Create an isolated environment; this intentionally
does not modify the Node workspace:

```bash
cd apps/speaker-identity
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

Before the first real enrollment, the enrolling user must accept the model
conditions for [`pyannote/embedding`](https://huggingface.co/pyannote/embedding)
and create a read token. Keep that token only in the local shell environment:

```bash
export HF_TOKEN=...
```

## Enroll and identify

Use a clean clip containing one consenting speaker. A few distinct samples per
person improve the centroid; do not enroll mixed-speaker meeting recordings.

```bash
hablabla-speakers enroll --name "Renzo" --audio ./renzo-clean.wav --consent
hablabla-speakers identify --audio ./speaker-segment.wav
hablabla-speakers list
hablabla-speakers delete PROFILE_ID
```

The module uses `pyannote/embedding` locally. It does not run diarization: feed
it diarized, single-speaker segments from the planned local speech bridge. Do
not equate a diarization label (`SPEAKER_00`) with a persistent identity.

## Verify storage logic

```bash
PYTHONPATH=. python3 -m unittest discover -s tests -v
```
