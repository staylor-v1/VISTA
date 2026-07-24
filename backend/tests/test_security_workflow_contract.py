"""Repository contracts for security scans that must fail closed."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = REPO_ROOT / ".github" / "workflows" / "container-scan-trivy.yml"


def _workflow_text() -> str:
    return WORKFLOW_PATH.read_text()


def _between(text: str, start: str, end: str) -> str:
    start_index = text.index(start)
    end_index = text.index(end, start_index)
    return text[start_index:end_index]


def test_trivy_report_uploads_before_high_and_critical_gate():
    workflow = _workflow_text()

    report_name = "- name: Generate Trivy vulnerability report"
    security_upload_name = "- name: Upload Trivy scan results to GitHub Security tab"
    artifact_upload_name = "- name: Upload Trivy scan artifact"
    gate_name = "- name: Enforce Trivy HIGH and CRITICAL vulnerability gate"
    dependency_job = "  dependency-scan:"

    assert (
        workflow.index(report_name)
        < workflow.index(security_upload_name)
        < workflow.index(artifact_upload_name)
        < workflow.index(gate_name)
    )

    report = _between(workflow, report_name, security_upload_name)
    security_upload = _between(workflow, security_upload_name, artifact_upload_name)
    artifact_upload = _between(workflow, artifact_upload_name, gate_name)
    gate = _between(workflow, gate_name, dependency_job)

    assert "severity: 'CRITICAL,HIGH'" in report
    assert "exit-code: '0'" in report
    assert "ignore-unfixed: false" in report
    assert "if: always()" in security_upload
    assert "upload-sarif@v4" in security_upload
    assert "if: always()" in artifact_upload
    assert "if-no-files-found: error" in artifact_upload
    assert "trivy-results.sarif" in artifact_upload
    assert "if: always()" in gate
    assert "severity: 'CRITICAL,HIGH'" in gate
    assert "exit-code: '1'" in gate
    assert "ignore-unfixed: false" in gate


def test_python_scanners_capture_real_exit_codes_without_silent_suppression():
    workflow = _workflow_text()

    assert "|| true" not in workflow

    install = _between(
        workflow,
        "- name: Install dependencies",
        "- name: Run Safety (Python dependency vulnerability scanner)",
    )
    safety = _between(
        workflow,
        "- name: Run Safety (Python dependency vulnerability scanner)",
        "- name: Run Bandit (Python security linter)",
    )
    bandit = _between(
        workflow,
        "- name: Run Bandit (Python security linter)",
        "- name: Run Semgrep (Static analysis for security bugs)",
    )
    semgrep = _between(
        workflow,
        "- name: Run Semgrep (Static analysis for security bugs)",
        "- name: Upload scan artifacts",
    )

    for scanner, block in (
        ("safety", safety),
        ("bandit", bandit),
        ("semgrep", semgrep),
    ):
        assert "if: always()" in block
        assert "set +e" in block
        assert "scan_status=${PIPESTATUS[0]}" in block
        assert f"security-scan-status/{scanner}.exit-code" in block

    assert '"safety==3.8.1"' in install
    assert '"bandit==1.9.4"' in install
    assert '"semgrep==1.170.0"' in install
    assert "uv export --frozen --no-dev --no-hashes" in safety
    assert "safety check" in safety
    assert "--output json" in safety
    assert "2> >(tee safety-scan.log >&2) | tee safety-results.json" in safety
    assert "--json" not in safety
    assert "--output safety-results.json" not in safety
    assert "bandit -r . -x ./tests -ll -ii" in bandit
    assert "--config=p/security-audit" in semgrep
    assert "--severity WARNING --severity ERROR --error" in semgrep


def test_python_scan_artifacts_upload_before_final_fail_closed_gate():
    workflow = _workflow_text()

    upload_name = "- name: Upload scan artifacts"
    gate_name = "- name: Enforce Python security scan results"
    assert workflow.index(upload_name) < workflow.index(gate_name)

    upload = _between(workflow, upload_name, gate_name)
    gate = workflow[workflow.index(gate_name) :]

    assert "if: always()" in upload
    assert "if-no-files-found: error" in upload
    for artifact in (
        "safety-results.json",
        "backend/bandit-results.json",
        "semgrep-results.json",
        "security-scan-status/",
    ):
        assert artifact in upload

    assert "if: always()" in gate
    assert "for scanner in safety bandit semgrep" in gate
    assert 'if [ ! -f "$status_file" ]' in gate
    assert 'if [ "$scan_status" != "0" ]' in gate
    assert 'exit "$failed"' in gate
