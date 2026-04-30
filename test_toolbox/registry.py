from typing import Dict

from .contracts import ToolboxExecutionResult, ToolboxManifest, WorkflowGraph, WorkflowNodeResult
from .methods import TOOLBOX_METHODS


def get_manifest() -> ToolboxManifest:
    return ToolboxManifest(methods=TOOLBOX_METHODS)


def _method_map() -> Dict[str, object]:
    return {method.id: method for method in TOOLBOX_METHODS}


def validate_workflow(workflow: WorkflowGraph) -> ToolboxExecutionResult:
    methods = _method_map()
    warnings = []
    node_results = []
    nodes_by_id = {node.id: node for node in workflow.nodes}
    source_nodes = [node for node in workflow.nodes if node.method_id == "source.project_part_images"]

    if workflow.source.kind == "project_parts" and len(source_nodes) < 1:
        raise ValueError("Project part workflows must contain at least one project image source node")

    outgoing = {node.id: [] for node in workflow.nodes}
    incoming = {node.id: [] for node in workflow.nodes}
    for edge in workflow.edges:
        outgoing[edge.source_node].append(edge.target_node)
        incoming[edge.target_node].append(edge.source_node)

    if source_nodes:
        reachable = set()
        visiting = set()

        def walk(node_id: str):
            if node_id in visiting:
                raise ValueError("Workflow graph cannot contain cycles")
            if node_id in reachable:
                return
            visiting.add(node_id)
            for target_id in outgoing.get(node_id, []):
                walk(target_id)
            visiting.remove(node_id)
            reachable.add(node_id)

        for source_node in source_nodes:
            walk(source_node.id)
        disconnected = sorted(set(nodes_by_id) - reachable)
        if disconnected:
            raise ValueError(f"Workflow contains nodes disconnected from an input source: {', '.join(disconnected)}")

    for node in workflow.nodes:
        method = methods.get(node.method_id)
        if method is None:
            raise ValueError(f"Unknown toolbox method '{node.method_id}'")
        allowed_parameters = {parameter.name: parameter for parameter in method.parameters}
        unknown_parameters = sorted(set(node.parameters) - set(allowed_parameters))
        if unknown_parameters:
            raise ValueError(f"Node '{node.id}' has unknown parameters: {', '.join(unknown_parameters)}")
        missing_required = [
            parameter.name
            for parameter in method.parameters
            if parameter.required and node.parameters.get(parameter.name, parameter.default) in (None, "")
        ]
        if missing_required:
            raise ValueError(f"Node '{node.id}' is missing required parameters: {', '.join(missing_required)}")
        for parameter_name, parameter_value in node.parameters.items():
            parameter = allowed_parameters[parameter_name]
            if parameter.min_value is not None and parameter_value not in (None, "") and float(parameter_value) < parameter.min_value:
                raise ValueError(f"Node '{node.id}' parameter '{parameter_name}' is below the minimum")
            if parameter.max_value is not None and parameter_value not in (None, "") and float(parameter_value) > parameter.max_value:
                raise ValueError(f"Node '{node.id}' parameter '{parameter_name}' is above the maximum")
            if parameter.type == "select" and parameter.options and parameter_value not in parameter.options:
                raise ValueError(f"Node '{node.id}' parameter '{parameter_name}' is not an allowed option")
        if node.method_id.startswith("ml.yolov8"):
            warnings.append("YOLOv8 nodes are contract-backed in test_toolbox; model execution is not bound yet.")
        node_results.append(
            WorkflowNodeResult(
                node_id=node.id,
                method_id=node.method_id,
                status="completed",
                output_types=method.output_types,
                message="Contract validation passed.",
            )
        )

    if not workflow.nodes:
        warnings.append("Workflow has no processing nodes.")

    return ToolboxExecutionResult(
        workflow_name=workflow.name,
        status="validated",
        execution_mode="validation",
        image_count=workflow.source.image_count,
        node_results=node_results,
        warnings=warnings,
    )


def execute_workflow(workflow: WorkflowGraph) -> ToolboxExecutionResult:
    validated = validate_workflow(workflow)
    return ToolboxExecutionResult(
        workflow_name=workflow.name,
        status="simulated",
        execution_mode="simulation",
        image_count=workflow.source.image_count,
        node_results=[
            result.model_copy(update={"message": "Simulation completed; no image artifacts were generated."})
            for result in validated.node_results
        ],
        warnings=validated.warnings,
    )
