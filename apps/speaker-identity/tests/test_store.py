import tempfile
import unittest
from pathlib import Path

from speaker_identity.store import SpeakerStore


class SpeakerStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.store = SpeakerStore(Path(self.directory.name) / "speakers.sqlite3")

    def tearDown(self) -> None:
        self.store.close()
        self.directory.cleanup()

    def test_enrolls_and_identifies_a_clear_match(self) -> None:
        profile = self.store.enroll("Renzo", [1, 0, 0], "test-model")
        self.store.enroll("Renzo", [0.98, 0.02, 0], "test-model")
        self.store.enroll("William", [0, 1, 0], "test-model")
        match = self.store.identify([0.99, 0.01, 0], "test-model", minimum_similarity=0.7)
        self.assertEqual(match.profile, self.store.list_profiles()[0])
        self.assertEqual(match.profile.id, profile.id)
        self.assertGreater(match.similarity or 0, 0.9)

    def test_rejects_an_ambiguous_match(self) -> None:
        self.store.enroll("A", [1, 0, 0], "test-model")
        self.store.enroll("B", [0.99, 0.01, 0], "test-model")
        match = self.store.identify([1, 0, 0], "test-model", minimum_similarity=0.7, minimum_margin=0.05)
        self.assertIsNone(match.profile)
        self.assertIn("too similar", match.reason)

    def test_deletion_removes_profile_and_embeddings(self) -> None:
        profile = self.store.enroll("Renzo", [1, 0], "test-model")
        self.assertTrue(self.store.delete(profile.id))
        self.assertEqual(self.store.list_profiles(), [])
        self.assertFalse(self.store.delete(profile.id))

    def test_rejects_mixed_models_for_one_profile(self) -> None:
        self.store.enroll("Renzo", [1, 0], "first-model")
        with self.assertRaises(ValueError):
            self.store.enroll("Renzo", [1, 0], "second-model")


if __name__ == "__main__":
    unittest.main()
