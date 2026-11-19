"""Search mode schemas (PLAN.md §5.5): the persisted what-if tree and the propagate endpoint.

`SearchTree` validates structure only. Whether `root_board` keeps the game's givens needs the
game, so `services.games` checks that (422 `givens_modified`).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sudoku_api.schemas.common import Grid

SEARCH_TREE_VERSION = 1
MAX_NODES = 500
MAX_NODE_ID_LENGTH = 36
MAX_TREE_BYTES = 256 * 1024

Cell = Annotated[int, Field(ge=0, le=80)]
Digit = Annotated[int, Field(ge=1, le=9)]
NodeId = Annotated[str, Field(min_length=1, max_length=MAX_NODE_ID_LENGTH)]
ContradictionKind = Literal["duplicate", "no_candidates", "digit_nowhere"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchChoice(_Strict):
    """The hypothesis of a node: "what if `cell` = `value`?"."""

    cell: Cell
    value: Digit


class SearchPlacement(_Strict):
    """An implication entered by the player (`manual`) or returned by propagate (`auto`)."""

    cell: Cell
    value: Digit
    source: Literal["manual", "auto"]


class Contradiction(_Strict):
    """A constraint violation (never a comparison with the solution)."""

    kind: ContradictionKind
    cells: Annotated[list[Cell], Field(max_length=81)]
    digit: Digit | None
    unit: Annotated[str, Field(max_length=32)] | None = Field(
        description='"row 3" / "column 5" / "box 2" (1-based); null for no_candidates'
    )
    explanation: Annotated[str, Field(max_length=500)]


class SearchNode(_Strict):
    id: NodeId
    parent_id: NodeId | None
    choice: SearchChoice | None
    placements: Annotated[list[SearchPlacement], Field(max_length=81)]
    status: Literal["open", "dead", "solved"]
    contradiction: Contradiction | None
    branch_cell: Cell | None = Field(
        description="Set on a parent whose children came from 'branch on all candidates'"
    )
    collapsed: bool


class SearchTree(_Strict):
    """The persisted search tree. Stored as is; scoring never trusts it."""

    version: Literal[1]
    root_board: Grid
    mode: Literal["manual", "auto"]
    selected_node_id: NodeId
    nodes: Annotated[list[SearchNode], Field(min_length=1, max_length=MAX_NODES)]

    @model_validator(mode="after")
    def _check_structure(self) -> SearchTree:
        by_id: dict[str, SearchNode] = {}
        for node in self.nodes:
            if node.id in by_id:
                raise ValueError(f"duplicate node id {node.id!r}")
            by_id[node.id] = node

        roots = [n for n in self.nodes if n.parent_id is None]
        if len(roots) != 1:
            raise ValueError(f"the tree must have exactly one root, found {len(roots)}")
        root = roots[0]
        if root.choice is not None or root.placements:
            raise ValueError("the root node must have no choice and no placements")

        children: dict[str, list[str]] = {}
        for node in self.nodes:
            if node.parent_id is None:
                continue
            if node.parent_id not in by_id:
                raise ValueError(f"node {node.id!r} has unknown parent_id {node.parent_id!r}")
            if node.choice is None:
                raise ValueError(f"non-root node {node.id!r} must have a choice")
            children.setdefault(node.parent_id, []).append(node.id)

        # One root and one parent per node: every node is reachable from the root iff
        # there are no cycles.
        reached = {root.id}
        stack = [root.id]
        while stack:
            for child in children.get(stack.pop(), ()):
                reached.add(child)
                stack.append(child)
        if len(reached) != len(self.nodes):
            raise ValueError("parent_id links contain a cycle")

        if self.selected_node_id not in by_id:
            raise ValueError("selected_node_id must be the id of a node")

        size = len(self.model_dump_json().encode())
        if size > MAX_TREE_BYTES:
            raise ValueError(
                f"the search tree is {size} bytes serialized; the limit is {MAX_TREE_BYTES}"
            )
        return self


class SearchCosts(BaseModel):
    auto_placement: int = Field(description="Points deducted per auto-filled cell")


class PropagateIn(BaseModel):
    board: Grid = Field(description="The selected node's board; must keep the givens")


class PropagationPlacementOut(BaseModel):
    cell: int
    value: int
    technique: Literal["Naked Single", "Hidden Single"]


class PropagateOut(BaseModel):
    placements: list[PropagationPlacementOut] = Field(description="In the order found")
    contradiction: Contradiction | None
    penalty: int = Field(description="Points this call deducts from the final score")
    auto_placements: int = Field(description="Total auto-filled cells for this game so far")
