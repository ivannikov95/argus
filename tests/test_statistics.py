import unittest

from backend.app import RegressionRequest, TableOneRequest, demo_frame, frame_to_rows, run_regression, run_table_one


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


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.rows = frame_to_rows(demo_frame())

    def test_binary_outcome_uses_logistic_regression(self):
        result = run_regression(RegressionRequest(
            rows=self.rows,
            outcome="event_30d",
            predictors=["age", "sex", "crp"],
        ))
        self.assertEqual(result["model_type"], "logistic")
        self.assertEqual(result["event_level"], "Да")
        self.assertLess(result["n"], 120)
        self.assertIn("pseudo_r_squared", result["metrics"])
        self.assertTrue(any(row["term"].startswith("sex:") for row in result["coefficients"]))
        self.assertEqual(len(result["diagnostics"]["predictions"]), result["n"])
        self.assertGreaterEqual(result["diagnostics"]["auc"], 0)
        self.assertLessEqual(result["diagnostics"]["auc"], 1)
        self.assertEqual(result["diagnostics"]["roc_curve"][0]["fpr"], 0)

    def test_numeric_outcome_uses_linear_regression(self):
        result = run_regression(RegressionRequest(
            rows=self.rows,
            outcome="lvef",
            predictors=["age", "group", "bmi"],
        ))
        self.assertEqual(result["model_type"], "linear")
        self.assertIsNone(result["event_level"])
        self.assertIsNone(result["diagnostics"])
        self.assertIn("r_squared", result["metrics"])
        self.assertTrue(any(row["term"].startswith("group:") for row in result["coefficients"]))

    def test_outcome_cannot_be_a_predictor(self):
        with self.assertRaisesRegex(Exception, "Исход нельзя"):
            run_regression(RegressionRequest(
                rows=self.rows,
                outcome="lvef",
                predictors=["lvef", "age"],
            ))

    def test_complete_separation_uses_firth_instead_of_exploding_odds_ratio(self):
        rows = [
            {"event": "Нет", "factor": 0}, {"event": "Нет", "factor": 0},
            {"event": "Нет", "factor": 0}, {"event": "Нет", "factor": 0},
            {"event": "Да", "factor": 1}, {"event": "Да", "factor": 1},
            {"event": "Да", "factor": 1}, {"event": "Да", "factor": 1},
        ]
        result = run_regression(RegressionRequest(rows=rows, outcome="event", predictors=["factor"]))
        factor = next(row for row in result["coefficients"] if row["term"].startswith("factor"))
        self.assertEqual(result["fit_method"], "firth")
        self.assertTrue(result["warnings"])
        self.assertLess(factor["effect"], 1_000_000)
        self.assertLess(factor["standard_error"], 10)


if __name__ == "__main__":
    unittest.main()
