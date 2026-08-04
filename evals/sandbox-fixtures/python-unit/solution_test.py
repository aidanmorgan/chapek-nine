import unittest
from solution import clamp

class ClampTests(unittest.TestCase):
    def test_bounds(self):
        self.assertEqual(clamp(-1, 0, 4), 0)
        self.assertEqual(clamp(7, 0, 4), 4)
        self.assertEqual(clamp(2, 0, 4), 2)
