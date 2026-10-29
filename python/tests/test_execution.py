from pathlib import Path

import pytest

from bonfire_portal.domain.errors import DomainError
from bonfire_portal.application import execution as execution_module
from bonfire_portal.application.execution import (
    ExecutionService, _compile_job, _io_context, _render,
    _validate_peer_bundle, _validate_peer_manifest,
)
from bonfire_portal.infrastructure.database import Database


def test_execution_prepare_requires_local_engine(tmp_path: Path):
    service = ExecutionService(Database(tmp_path / "portal.sqlite"))
    with pytest.raises(DomainError, match="本地引擎"):
        service.prepare("run-1", "connector-a", {"provider_connector_id": "connector-a"}, {})


def test_execution_prepare_persists_request_hash(tmp_path: Path):
    service = ExecutionService(Database(tmp_path / "portal.sqlite"))
    profile = {"domain_id": "domain-a", "engine_datasource_ref": "storage-a"}
    request = {"provider_connector_id": "connector-a", "consumer_connector_id": "connector-b"}
    row = service.prepare("run-1", "connector-a", request, profile)
    assert row["validated"] is True
    assert service.get("run-1", "connector-a")["request_hash"] == row["request_hash"]


def test_task_template_supports_exact_and_embedded_values():
    rendered = _render({"path": "{{ outputs.result.relative_uri }}", "label": "run-{{run.id}}"}, {
        "run": {"id": "42"}, "outputs": {"result": {"relative_uri": "/data/out.csv"}},
    })
    assert rendered == {"path": "/data/out.csv", "label": "run-42"}


def test_task_template_is_application_defined_not_psi_specific():
    rendered = _render({
        "left": "{{inputs.sender.relative_uri}}",
        "right": "{{inputs.recver.relative_uri}}",
        "destination": "{{outputs.result.relative_uri}}",
        "threshold": "{{parameters.threshold}}",
    }, {
        "inputs": {
            "sender": {"relative_uri": "/data/a.csv"},
            "recver": {"relative_uri": "/data/b.csv"},
        },
        "outputs": {"result": {"relative_uri": "/data/result.csv"}},
        "parameters": {"threshold": 5},
    })
    assert rendered == {
        "left": "/data/a.csv", "right": "/data/b.csv",
        "destination": "/data/result.csv", "threshold": 5,
    }


def test_io_context_uses_declared_port_and_workflow_bindings():
    request = {
        "provider_connector_id": "provider", "consumer_connector_id": "consumer",
        "provider_resource_ref": "resource-a", "consumer_resource_ref": "resource-b",
        "provider_resource": {"metadata": {"format": "csv", "columns": [{"name": "id"}]}},
        "consumer_resource": {"metadata": {"format": "parquet", "columns": [{"name": "key"}]}},
        "workflow": {"nodes": [{
            "id": "task-a", "app_image": "generic-app",
            "input_bindings": [
                {"port": "left_table", "domaindata_id": "resource-a"},
                {"port": "right_table", "domaindata_id": "resource-b"},
            ],
            "output_bindings": [{"port": "matches", "relative_uri": "runs/result.json"}],
        }]},
    }
    app = {"name": "generic-app", "io_schema": {
        "inputs": [{"name": "left_table", "kind": "table"}, {"name": "right_table", "kind": "table"}],
        "outputs": [{"name": "matches", "kind": "table", "formats": ["json"]}],
    }}

    inputs, outputs = _io_context(request, app, "/data/provider.csv", "/data/consumer.parquet", "job-1")

    assert inputs["left_table"]["relative_uri"] == "/data/provider.csv"
    assert inputs["right_table"]["relative_uri"] == "/data/consumer.parquet"
    assert outputs["matches"]["relative_uri"] == "/home/kuscia/var/storage/data/runs/result.json"
    assert outputs["matches"]["format"] == "json"


def test_peer_manifest_is_bound_to_run_connector_domain_and_session():
    task_id = "ing-" + "a" * 32; session_id = "b" * 32
    manifest = {"run_id": "run-1", "connector_id": "connector-b", "domain_id": "domain-b",
        "resource_ref": "resource-b", "resource_version": "3", "ingestion_task_id": task_id,
        "session_id": session_id, "resources": [{"engine_input_id": task_id + "-0",
            "relative_uri": f"staging/ftp/{session_id}/files/data.csv", "sha256": "c" * 64,
            "format": "csv", "columns": [{"name": "id", "type": "string"}]}]}
    expected = {"run_id": "run-1", "connector_id": "connector-b", "domain_id": "domain-b",
        "resource_ref": "resource-b", "resource_version": "3"}
    _validate_peer_manifest(manifest, expected)
    with pytest.raises(DomainError, match="归属或版本"):
        _validate_peer_manifest({**manifest, "run_id": "other"}, expected)
    with pytest.raises(DomainError, match="越界"):
        _validate_peer_manifest({**manifest, "resources": [{**manifest["resources"][0], "relative_uri": "staging/ftp/other/files/data.csv"}]}, expected)


def test_peer_bundle_requires_every_declared_peer_resource():
    task_id, session_id = "ing-" + "a" * 32, "b" * 32
    manifest = {"run_id": "run-1", "connector_id": "connector-b", "domain_id": "domain-b",
        "resource_ref": "resource-b", "resource_version": "3", "ingestion_task_id": task_id,
        "session_id": session_id, "resources": [{"engine_input_id": task_id + "-0",
            "relative_uri": f"staging/ftp/{session_id}/files/data.csv", "sha256": "c" * 64,
            "format": "csv", "columns": [{"name": "id", "type": "string"}]}]}
    # The business request id and center run id are separate identities.
    request = {"request_id": "exec-1", "resources": [{"connector_id": "connector-b", "ref": "resource-b", "version": "3"}]}
    result = _validate_peer_bundle({"run_id": "run-1", "connector_id": "connector-b",
        "domain_id": "domain-b", "manifests": [manifest]}, request, "connector-b", "domain-b", "run-1")
    assert result == {"resource-b": manifest}
    with pytest.raises(DomainError, match="不完整"):
        _validate_peer_bundle({"run_id": "run-1", "connector_id": "connector-b",
            "domain_id": "domain-b", "manifests": []}, request, "connector-b", "domain-b", "run-1")


def test_compile_job_builds_generic_multi_node_dag():
    def application(name, inputs, outputs, template):
        return {"task_input_template": template, "implementation_metadata": {"appimage": {
            "name": name, "image_name": f"example/{name}", "image_tag": "v1",
            "deploy_templates": [], "config_templates": {},
            "io_schema": {"inputs": inputs, "outputs": outputs},
        }}}
    request = {
        "request_id": "run-1", "project_id": "project-1", "dispatch_connector_id": "connector-a",
        "provider_connector_id": "connector-a", "consumer_connector_id": "connector-b",
        "resources": [
            {"connector_id": "connector-a", "ref": "left", "version": "1", "metadata": {"format": "csv"}},
            {"connector_id": "connector-b", "ref": "right", "version": "1", "metadata": {"format": "csv"}},
        ],
        "applications": {
            "merge": application("merge", [{"name": "a"}, {"name": "b"}], [{"name": "joined", "formats": ["parquet"]}],
                                 {"a": "{{inputs.a.relative_uri}}", "b": "{{inputs.b.relative_uri}}", "out": "{{outputs.joined.relative_uri}}"}),
            "summarize": application("summarize", [{"name": "source"}], [{"name": "report", "formats": ["json"]}],
                                     {"source": "{{inputs.source.relative_uri}}", "report": "{{outputs.report.relative_uri}}"}),
        },
        "workflow": {"nodes": [
            {"id": "merge-task", "app_image": "merge", "parties": [
                {"domain_id": "connector-a", "role": "left"}, {"domain_id": "connector-b", "role": "right"}],
             "input_bindings": [{"port": "a", "domaindata_id": "left"}, {"port": "b", "domaindata_id": "right"}],
             "output_bindings": [{"port": "joined", "domaindata_id": "middle", "relative_uri": "runs/middle.parquet", "format": "parquet"}]},
            {"id": "summary-task", "app_image": "summarize", "parties": [{"domain_id": "connector-a", "role": "reader"}],
             "input_bindings": [{"port": "source", "domaindata_id": "middle", "source_node": "merge-task"}],
             "output_bindings": [{"port": "report", "domaindata_id": "report", "relative_uri": "runs/report.json", "format": "json"}]},
        ], "edges": [{"type": "data", "source": "merge-task", "target": "summary-task"}]},
    }
    manifests = {
        "left": {"resources": [{"relative_uri": "staging/left.csv", "sha256": "a" * 64}]},
        "right": {"resources": [{"relative_uri": "staging/right.csv", "sha256": "b" * 64}]},
    }

    job, outputs, images = _compile_job(
        request, manifests, "kuscia-run-1", {"connector-a": "domain-a", "connector-b": "domain-b"}
    )

    assert [task["app_image"] for task in job["tasks"]] == ["merge", "summarize"]
    assert job["tasks"][1]["dependencies"] == ["merge-task"]
    assert "runs/middle.parquet" in job["tasks"][1]["task_input_config"]
    assert outputs["summary-task"]["report"]["format"] == "json"
    assert {image["name"] for image in images} == {"merge", "summarize"}


def test_compile_job_rejects_input_format_not_declared_by_appimage():
    request = {
        "request_id": "run-1", "project_id": "project-1", "dispatch_connector_id": "connector-a",
        "provider_connector_id": "connector-a", "consumer_connector_id": "connector-b",
        "resources": [{"connector_id": "connector-a", "ref": "left", "version": "1",
                       "metadata": {"format": "parquet"}}],
        "applications": {"csv-only": {"task_input_template": {"input": "{{inputs.source.relative_uri}}"},
            "implementation_metadata": {"appimage": {"name": "csv-only", "image_name": "example/csv-only",
                "image_tag": "v1", "deploy_templates": [], "config_templates": {},
                "io_schema": {"inputs": [{"name": "source", "formats": ["csv"]}], "outputs": []}}}}},
        "workflow": {"nodes": [{"id": "task", "app_image": "csv-only",
            "parties": [{"domain_id": "connector-a", "role": "reader"}],
            "input_bindings": [{"port": "source", "domaindata_id": "left"}],
            "output_bindings": []}], "edges": []},
    }
    manifests = {"left": {"resources": [{"relative_uri": "staging/left.parquet", "format": "parquet", "sha256": "a" * 64}]}}

    with pytest.raises(DomainError, match="不支持格式 parquet"):
        _compile_job(request, manifests, "kuscia-run-1", {"connector-a": "domain-a", "connector-b": "domain-b"})


@pytest.mark.asyncio
async def test_non_dispatch_data_owner_creates_grant_before_returning(tmp_path: Path, monkeypatch):
    class FakeExtraction:
        created = []

        def create(self, body, connector_id, profile):
            self.created.append(body)
            return {"id": "ing-" + "a" * 32}

        async def run(self, task_id, connector_id, profile):
            return {"state": "ready", "id": task_id, "session_id": "b" * 32, "resources": [{
                "engine_input_id": task_id + "-0",
                "relative_uri": "staging/ftp/" + "b" * 32 + "/files/data.csv",
                "sha256": "c" * 64, "size": 8, "format": "csv",
                "columns": [{"name": "id", "type": "string"}],
            }]}

    calls = []

    class FakeLiteClient:
        def __init__(self, endpoint, cert_dir):
            pass

        async def create_domain_data_grant(self, owner, data_id, grantee):
            calls.append((owner, data_id, grantee))

    monkeypatch.setattr(execution_module, "LiteClient", FakeLiteClient)
    service = ExecutionService(Database(tmp_path / "portal.sqlite"), FakeExtraction())
    request = {
        "request_id": "run-1", "provider_connector_id": "connector-a",
        "consumer_connector_id": "connector-b", "dispatch_connector_id": "connector-a",
        "provider_execution_node_ref": "domain-a", "consumer_execution_node_ref": "domain-b",
        "resources": [{"connector_id": "connector-b", "ref": "right", "version": "1",
                       "metadata": {"connector_datasource_ref": "source-b", "relative_uri": "data.csv",
                                    "format": "csv", "columns": [{"name": "id", "type": "string"}]}}],
    }
    profile = {"domain_id": "domain-b", "engine_datasource_ref": "storage-b",
               "lite_kuscia_endpoint": "https://kuscia-b:28081", "lite_cert_dir": "/certs"}

    result = await service.execute("run-1", "connector-b", request, profile, service.db)

    assert result["status"] == "accepted"
    assert calls == [("domain-b", "ing-" + "a" * 32 + "-0", "domain-a")]
    assert service.extraction.created[0]["dr_resource_id"] == "right"
    assert service.extraction.created[0]["output_format"] == "csv"
    assert not result.get("submitted")


@pytest.mark.asyncio
async def test_compute_input_converts_non_csv_source_to_csv(tmp_path: Path, monkeypatch):
    class FakeExtraction:
        created = []

        def create(self, body, connector_id, profile):
            self.created.append(body)
            return {"id": "ing-" + "d" * 32}

        async def run(self, task_id, connector_id, profile):
            return {"state": "ready", "id": task_id, "session_id": "e" * 32, "resources": [{
                "engine_input_id": task_id + "-0",
                "relative_uri": "staging/ftp/" + "e" * 32 + "/files/data.csv",
                "sha256": "f" * 64, "size": 8, "format": "csv",
                "columns": [{"name": "id", "type": "string"}],
            }]}

    class FakeLiteClient:
        def __init__(self, endpoint, cert_dir):
            pass

        async def create_domain_data_grant(self, owner, data_id, grantee):
            return None

    monkeypatch.setattr(execution_module, "LiteClient", FakeLiteClient)
    extraction = FakeExtraction()
    service = ExecutionService(Database(tmp_path / "portal.sqlite"), extraction)
    request = {
        "request_id": "run-parquet", "provider_connector_id": "connector-a",
        "consumer_connector_id": "connector-b", "dispatch_connector_id": "connector-a",
        "provider_execution_node_ref": "domain-a", "consumer_execution_node_ref": "domain-b",
        "resources": [{"connector_id": "connector-b", "ref": "right", "version": "1",
                       "metadata": {"connector_datasource_ref": "source-b", "relative_uri": "data.parquet",
                                    "format": "parquet", "columns": [{"name": "id", "type": "string"}]}}],
    }
    profile = {"domain_id": "domain-b", "engine_datasource_ref": "storage-b",
               "lite_kuscia_endpoint": "https://kuscia-b:28081", "lite_cert_dir": "/certs"}

    result = await service.execute("run-parquet", "connector-b", request, profile, service.db)

    assert extraction.created[0]["dr_resource_id"] == "right"
    assert "input_format" not in extraction.created[0]
    assert extraction.created[0]["output_format"] == "csv"
    assert result["prepared_bundle"]["manifests"][0]["resources"][0]["format"] == "csv"


def test_file_port_uses_raw_resource_format_and_table_stays_csv():
    from bonfire_portal.application.execution import _compute_input_spec
    resource={'ref':'r','metadata':{'format':'json'}}
    request={'workflow':{'nodes':[{'app_image':'a','input_bindings':[{'port':'model','resource_ref':'r'}]}]},
             'applications':{'a':{'implementation_metadata':{'appimage':{'io_schema':{'inputs':[{'name':'model','kind':'file','formats':['json']}]}}}}}}
    assert _compute_input_spec(resource,request)=={'output_format':'json','content_mode':'raw'}
    request['applications']['a']['implementation_metadata']['appimage']['io_schema']['inputs'][0]['kind']='table'
    assert _compute_input_spec(resource,request)=={'output_format':'csv','content_mode':'structured'}


def test_input_format_inference_respects_connector_ownership_and_ref_collision():
    from bonfire_portal.application.execution import _compute_input_spec,_resources
    resource={'ref':'same','connector_id':'left','metadata':{'format':'json'}}
    request={'workflow':{'nodes':[{'app_image':'a','input_bindings':[{'port':'model','resource_ref':'same','domain_id':'right'}]}]},
             'applications':{'a':{'implementation_metadata':{'appimage':{'io_schema':{'inputs':[{'name':'model','kind':'file','formats':['json']}]}}}}}}
    assert _compute_input_spec(resource,request)['content_mode']=='structured'
    request['resources']=[resource,{'ref':'same','connector_id':'right'}]
    with pytest.raises(DomainError,match='重名'):_resources(request)


def test_long_multi_instance_task_ids_are_bounded_unique_and_keep_dependencies():
    nodes=[{'id':'application-instance-'+('a'*18)+n,'app_image':'component','parties':[{'domain_id':'connector','role':'worker'}]} for n in ('a','b')]
    request={'dispatch_connector_id':'connector','workflow':{'nodes':nodes,'edges':[{'source':nodes[0]['id'],'target':nodes[1]['id'],'type':'control'}]},
             'applications':{'component':{'implementation_metadata':{'appimage':{'name':'component','io_schema':{'inputs':[],'outputs':[]}}},'task_input_template':{}}}}
    first,_,_=_compile_job(request,{},'job-'+('f'*32),{'connector':'domain'})
    second,_,_=_compile_job(request,{},'job-'+('f'*32),{'connector':'domain'})
    ids=[t['task_id'] for t in first['tasks']]
    assert all(len(t)==63 for t in ids) and len(set(ids))==2
    assert first==second
    assert first['tasks'][1]['dependencies']==[nodes[0]['id']]
    assert [t['alias'] for t in first['tasks']]==[n['id'] for n in nodes]
