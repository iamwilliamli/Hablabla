"""SQLite storage for consented speaker embeddings.

This module deliberately stores embeddings only: never raw audio, transcripts,
or a biometric match as an authentication credential.  A match is a suggestion
for a user to confirm.
"""

from __future__ import annotations

import math
import sqlite3
import struct
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable
from uuid import uuid4


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _normalise(values: Iterable[float]) -> tuple[float, ...]:
    vector = tuple(float(value) for value in values)
    if not vector:
        raise ValueError("A speaker embedding cannot be empty.")
    if not all(math.isfinite(value) for value in vector):
        raise ValueError("A speaker embedding must contain finite values.")
    magnitude = math.sqrt(sum(value * value for value in vector))
    if magnitude == 0:
        raise ValueError("A speaker embedding cannot be the zero vector.")
    return tuple(value / magnitude for value in vector)


def _pack(values: tuple[float, ...]) -> bytes:
    return struct.pack(f"!{len(values)}f", *values)


def _unpack(blob: bytes, dimension: int) -> tuple[float, ...]:
    if len(blob) != dimension * 4:
        raise ValueError("Stored speaker embedding has an invalid length.")
    return tuple(struct.unpack(f"!{dimension}f", blob))


@dataclass(frozen=True)
class SpeakerProfile:
    id: str
    display_name: str
    model_id: str
    embedding_dimension: int
    enrollment_count: int
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class SpeakerMatch:
    profile: SpeakerProfile | None
    similarity: float | None
    second_best_similarity: float | None
    reason: str


class SpeakerStore:
    """A single-user SQLite profile store with model-version isolation."""

    def __init__(self, database: str | Path):
        self.path = Path(database)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(self.path)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._migrate()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "SpeakerStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _migrate(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS speaker_profiles (
              id TEXT PRIMARY KEY,
              display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
              model_id TEXT NOT NULL,
              embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
              centroid BLOB NOT NULL,
              enrollment_count INTEGER NOT NULL CHECK (enrollment_count > 0),
              consented_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS speaker_enrollments (
              id TEXT PRIMARY KEY,
              profile_id TEXT NOT NULL REFERENCES speaker_profiles(id) ON DELETE CASCADE,
              embedding BLOB NOT NULL,
              enrolled_at TEXT NOT NULL
            );
            """
        )
        self._connection.commit()

    @staticmethod
    def _profile(row: sqlite3.Row) -> SpeakerProfile:
        return SpeakerProfile(
            id=row["id"],
            display_name=row["display_name"],
            model_id=row["model_id"],
            embedding_dimension=row["embedding_dimension"],
            enrollment_count=row["enrollment_count"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_profiles(self) -> list[SpeakerProfile]:
        rows = self._connection.execute(
            "SELECT * FROM speaker_profiles ORDER BY display_name COLLATE NOCASE"
        ).fetchall()
        return [self._profile(row) for row in rows]

    def enroll(self, display_name: str, embedding: Iterable[float], model_id: str) -> SpeakerProfile:
        """Add a consented sample and recompute that profile's normalized centroid."""
        name = display_name.strip()
        if not name:
            raise ValueError("A display name is required.")
        if not model_id.strip():
            raise ValueError("A model ID is required.")
        vector = _normalise(embedding)
        now = _now()
        current = self._connection.execute(
            "SELECT * FROM speaker_profiles WHERE display_name = ?", (name,)
        ).fetchone()
        with self._connection:
            if current is None:
                profile_id = str(uuid4())
                centroid = vector
                self._connection.execute(
                    """INSERT INTO speaker_profiles
                    (id, display_name, model_id, embedding_dimension, centroid, enrollment_count,
                     consented_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                    (profile_id, name, model_id, len(vector), _pack(vector), now, now, now),
                )
            else:
                if current["model_id"] != model_id or current["embedding_dimension"] != len(vector):
                    raise ValueError("Enrollments for one profile must use the same embedding model and dimension.")
                count = current["enrollment_count"]
                previous = _unpack(current["centroid"], current["embedding_dimension"])
                centroid = _normalise(
                    ((previous[index] * count + vector[index]) / (count + 1) for index in range(len(vector)))
                )
                profile_id = current["id"]
                self._connection.execute(
                    """UPDATE speaker_profiles SET centroid = ?, enrollment_count = ?, updated_at = ?
                    WHERE id = ?""",
                    (_pack(centroid), count + 1, now, profile_id),
                )
            self._connection.execute(
                "INSERT INTO speaker_enrollments (id, profile_id, embedding, enrolled_at) VALUES (?, ?, ?, ?)",
                (str(uuid4()), profile_id, _pack(vector), now),
            )
        row = self._connection.execute("SELECT * FROM speaker_profiles WHERE id = ?", (profile_id,)).fetchone()
        assert row is not None
        return self._profile(row)

    def identify(
        self,
        embedding: Iterable[float],
        model_id: str,
        *,
        minimum_similarity: float = 0.78,
        minimum_margin: float = 0.05,
    ) -> SpeakerMatch:
        """Return a tentative match only when it clears score and ambiguity thresholds."""
        if not 0 < minimum_similarity <= 1 or minimum_margin < 0:
            raise ValueError("Invalid identification thresholds.")
        vector = _normalise(embedding)
        rows = self._connection.execute(
            "SELECT * FROM speaker_profiles WHERE model_id = ? AND embedding_dimension = ?",
            (model_id, len(vector)),
        ).fetchall()
        if not rows:
            return SpeakerMatch(None, None, None, "No compatible consented speaker profiles are enrolled.")
        candidates = sorted(
            ((sum(left * right for left, right in zip(vector, _unpack(row["centroid"], len(vector)))), row) for row in rows),
            reverse=True,
            key=lambda candidate: candidate[0],
        )
        best_score, best_row = candidates[0]
        runner_up = candidates[1][0] if len(candidates) > 1 else None
        if best_score < minimum_similarity:
            return SpeakerMatch(None, best_score, runner_up, "No profile met the similarity threshold.")
        if runner_up is not None and best_score - runner_up < minimum_margin:
            return SpeakerMatch(None, best_score, runner_up, "The closest profiles are too similar to identify reliably.")
        return SpeakerMatch(self._profile(best_row), best_score, runner_up, "Tentative match; ask the user to confirm.")

    def delete(self, profile_id: str) -> bool:
        with self._connection:
            result = self._connection.execute("DELETE FROM speaker_profiles WHERE id = ?", (profile_id,))
        return result.rowcount == 1
