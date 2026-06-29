import unittest

from backend.app import TableOneRequest, demo_frame, frame_to_rows, run_table_one


class TableOneTests(unittest.TestCase):
    def setUp(self):
        self.rows = frame_to_rows(demo_frame())

    def test_table_one_has_expected_groups_and_variables(self):
        result = run_table_one(
            TableOneRequest(
                rows=self.rows,
                group_column="group",
                variables=["age", "sex", "crp", "lvef"],
            )
        )
        self.assertEqual(result["n"], 120)
        self.assertEqual([group["n"] for group in result["groups"]], [60, 60])
        self.assertEqual(len(result["rows"]), 4)

    def test_skewed_variable_uses_nonparametric_presentation(self):
        result = run_table_one(
            TableOneRequest(rows=self.rows, group_column="group", variables=["crp"])
        )
        row = result["rows"][0]
        self.assertEqual(row["presentation"], "Медиана [Q1; Q3]")
        self.assertEqual(row["test"], "U-критерий Манна–Уитни")

    def test_identifier_is_never_summarized(self):
        result = run_table_one(
            TableOneRequest(rows=self.rows, variables=["patient_id", "age"])
        )
        self.assertEqual([row["variable"] for row in result["rows"]], ["age"])

    def test_manual_parametric_mode_returns_confidence_interval(self):
        result = run_table_one(
            TableOneRequest(
                rows=self.rows,
                group_column="group",
                variables=["crp"],
                numeric_presentation="mean_sd",
                numeric_test="parametric",
            )
        )
        row = result["rows"][0]
        self.assertEqual(row["presentation"], "Среднее ± SD")
        self.assertEqual(row["test"], "t-критерий Уэлча")
        self.assertNotEqual(row["ci_display"], "—")
        self.assertIn("Разность средних", row["ci_label"])

    def test_categorical_levels_and_odds_ratio_interval_are_returned(self):
        result = run_table_one(
            TableOneRequest(
                rows=self.rows,
                group_column="group",
                variables=["event_30d"],
                categorical_test="fisher",
            )
        )
        row = result["rows"][0]
        self.assertEqual(row["test"], "Точный критерий Фишера")
        self.assertEqual(len(row["levels"]), 2)
        self.assertNotEqual(row["ci_display"], "—")
        self.assertIn("ОШ", row["ci_label"])


if __name__ == "__main__":
    unittest.main()
