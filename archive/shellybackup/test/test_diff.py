import unittest
import difflib
import itertools
from shellybackup import get_side_by_side_diff

unittest.TestCase.maxDiff = None # show the complete diff for fails

class TestSideBySideDiff(unittest.TestCase):

    def test_whitespace_and_content_changes_not_suppressed(self):
        """Differences in content and non-trailing whitespace should be flagged as 'replace' (|)."""

        left = (
            "Line 1 (equal)\n"
            "Line 2 (content change)\n"
            "Line 3 (whitespace change)\n"
            "Line 4 (trailing whitespace change)   \n"
            "Line 5 (trailing whitespace (tab) change)\t\n"
            "Line 6 (equal again)\n"
        )

        right = (
            "Line 1 (equal)\n"
            "Line 2 (content different)\n"
            "Line 3  (whitespace change)\n"
            "Line 4 (trailing whitespace change)\n"
            "Line 5 (trailing whitespace (tab) change)\n"
            "Line 6 (equal again)\n"
        )

        # output should be padded to width, both sides
        expected_output = "\n".join([
            "  # | INPUT (File)                                       | DEVICE (Live)                                     ",
            "    | -------------------------------------------------- | --------------------------------------------------",
            "  1 | Line 1 (equal)                                       Line 1 (equal)                                    ",
            "  2 | Line 2 (content change)                            | Line 2 (content different)                        ",
            "  3 | Line 3 (whitespace change)                         | Line 3  (whitespace change)                       ",
            "  4 | Line 4 (trailing whitespace change)                  Line 4 (trailing whitespace change)               ",
            "  5 | Line 5 (trailing whitespace (tab) change)            Line 5 (trailing whitespace (tab) change)         ",
            "  6 | Line 6 (equal again)                                 Line 6 (equal again)                              ",
        ])

        actual_output = get_side_by_side_diff(left, right, width=50, suppress_equal=False)
        self.assertEqual(actual_output, expected_output)

    def test_whitespace_and_content_changes(self):
        """Differences in content and non-trailing whitespace should be flagged as 'replace' (|)."""

        left = (
            "Line 1 (equal)\n"
            "Line 2 (content change)\n"
            "Line 3 (whitespace change)\n"
            "Line 4 (trailing whitespace change)   \n"
            "Line 5 (trailing whitespace (tab) change)\t\n"
            "Line 6 (equal again)\n"
        )

        right = (
            "Line 1 (equal)\n"
            "Line 2 (content different)\n"
            "Line 3  (whitespace change)\n"
            "Line 4 (trailing whitespace change)\n"
            "Line 5 (trailing whitespace (tab) change)\n"
            "Line 6 (equal again)\n"
        )

        # output should be padded to width, both sides
        expected_output = "\n".join([
            "  # | INPUT (File)                                       | DEVICE (Live)                                     ",
            "    | -------------------------------------------------- | --------------------------------------------------",
            "  2 | Line 2 (content change)                            | Line 2 (content different)                        ",
            "  3 | Line 3 (whitespace change)                         | Line 3  (whitespace change)                       ",
        ])

        actual_output = get_side_by_side_diff(left, right, width=50)
        self.assertEqual(actual_output, expected_output)

    def test_insertions(self):
        """Added lines should be marked as 'insert' (>)."""
        
        left = (
            "Line 1\n"
            "Line 2\n"
            "Line 3\n"
            "Line 5\n"
            "X\n"
        )

        right = (
            "Line 1\n"
            "Line 2\n"
            "Line 3\n"
            "Line 4\n"
            "Line 5\n"
            "X\n"
            "X\n"   # which one's the new line?
        )

        # output should be padded to width, both sides
        expected_output = "\n".join([
            "  # | INPUT (File)                                       | DEVICE (Live)                                     ",
            "    | -------------------------------------------------- | --------------------------------------------------",
            "  4 |                                                    > Line 4                                            ",
            "  7 |                                                    > X                                                 ",
        ])
        
        actual_output = get_side_by_side_diff(left, right, width=50)
        self.assertEqual(actual_output, expected_output)

    def test_deletions(self):
        """Removed lines should be marked as 'delete' (<)."""
        
        left = (
            "Line 1\n"
            "Line 2\n"
            "Line 3\n"
            "Line 4\n"
            "Line 5\n"
            "X\n"
            "X\n"
        )

        right = (
            "Line 1\n"
            "Line 2\n"
            "Line 3\n"
            "Line 5\n"
            "X\n"   # which one's gone?
        )

        # output should be padded to width, both sides
        expected_output = "\n".join([
            "  # | INPUT (File)                                       | DEVICE (Live)                                     ",
            "    | -------------------------------------------------- | --------------------------------------------------",
            "  4 | Line 4                                             <                                                   ",
            "  7 | X                                                  <                                                   ",
        ])
        
        actual_output = get_side_by_side_diff(left, right, width=50)
        self.assertEqual(actual_output, expected_output)

    def test_changes_insertions_and_deletions(self):
        """Changes (|), added lines 'insert' (>) and removed 'delete' (<)."""
        
        left = (
            "Line 2\n"
            "Line 3\n"
            "X\n"
            "X\n"       # deleted
            "Line 6\n"  # deleted
            "Line 7\n"
        )

        right = (
            "Line 1\n"  # added
            "Line 2\n"  # same
            "Line 3.14\n"  # change
            "X\n"       # same
            "Line 7\n"
        )

        # output should be padded to width, both sides
        expected_output = "\n".join([
            "  # | INPUT (File)                                       | DEVICE (Live)                                     ",
            "    | -------------------------------------------------- | --------------------------------------------------",
            "  1 |                                                    > Line 1                                            ",
            "  3 | Line 3                                             | Line 3.14                                         ",
            "  5 | X                                                  <                                                   ",
            "  6 | Line 6                                             <                                                   ",
        ])
        
        actual_output = get_side_by_side_diff(left, right, width=50)
        self.assertEqual(actual_output, expected_output)

if __name__ == '__main__':
    unittest.main() 
