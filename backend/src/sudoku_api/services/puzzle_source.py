"""Where new puzzles come from.

`PuzzleSource.get(difficulty)` returns `(givens, solution, difficulty, rating_score,
techniques[, seed])`, or raises `PuzzleSourceError`. Callers must still run the result
through `validate_puzzle` before inserting it (see `services/pool.py`).
"""

from __future__ import annotations

import random
import threading
from collections.abc import Callable, Mapping, Sequence
from functools import partial
from typing import NamedTuple, Protocol, runtime_checkable

from sudoku_api.config import Settings
from sudoku_api.domain import Difficulty
from sudoku_api.services import puzzle_logic


class SourcePuzzle(NamedTuple):
    givens: str  # 81 chars, "0" = empty
    solution: str  # 81 chars
    difficulty: Difficulty
    rating_score: int
    techniques: dict[str, int]
    seed: int | None = None


class PuzzleSourceError(Exception):
    """A source could not produce a puzzle (callers turn this into 503 or retry later)."""


class NoPuzzleAvailableError(PuzzleSourceError, LookupError):
    """The source has no puzzles at all for this difficulty."""


class PuzzleGenerationError(PuzzleSourceError):
    """Generation failed or ran out of time/attempts."""


class PuzzleSource(Protocol):
    generator_version: str

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        """Return a candidate or raise `PuzzleSourceError`. May be slow (CPU-bound)."""
        ...


@runtime_checkable
class ProcessPuzzleSource(PuzzleSource, Protocol):
    """A source whose work can run in another process.

    `job()` runs in the calling process (e.g. to draw a seed) and returns a picklable
    zero-argument callable that does the expensive part.
    """

    def job(
        self, difficulty: Difficulty, timeout: float | None = None
    ) -> Callable[[], SourcePuzzle]: ...


# Real puzzles labelled by `sudoku_validator.rate()`. Each passes
# `validate_puzzle(givens, solution, claimed=level)`, and tests re-check this. Scores and
# technique counts are not stored here: they are recomputed with `rate()` on every draw.
# A level may be left empty; the pool then stays empty for it and new games at that
# level return 503 until the generator is integrated.
_FIXTURES: dict[Difficulty, list[tuple[str, str]]] = {
    Difficulty.beginner: [
        (
            "980200300042910050530608900210096800000020000009130067007401089090082740008009023",
            "986257314742913658531648972214796835673825491859134267327461589195382746468579123",
        ),
        (
            "071060809650798000408100070000051760100906002036470000080005907000247083703010240",
            "371564829652798431498123576829351764147986352536472198284635917915247683763819245",
        ),
    ],
    Difficulty.easy: [
        (
            "080200300040010000500600900210090800000000000009030067007001009000080040008009020",
            "986257314742913658531648972214796835673825491859134267327461589195382746468579123",
        ),
        (
            "070000809050090000408100070000051060100906002030470000080005907000040080703000040",
            "371564829652798431498123576829351764147986352536472198284635917915247683763819245",
        ),
    ],
    Difficulty.medium: [
        (
            "600200403000030960900006000470008000001000600000900034000500001082090000106003002",
            "618259473527134968934876215473628159891345627265917834749562381382791546156483792",
        ),
        (
            "000368400600000000010009000401905008087000930300802504000600050000000009009451000",
            "975368421632714895814529376421935768587146932396872514248693157153287649769451283",
        ),
    ],
    Difficulty.hard: [
        (
            "000140000030002045400090000200000190940000078073000002000080006850400030000059000",
            "687145329139762845425893617268574193941236578573918462794381256856427931312659784",
        ),
        (
            "000000809906100000300900020000001006708000904200600000020004001000008705609000000",
            "172435869986127543345986127593841276768352914214679358827594631431268795659713482",
        ),
    ],
    Difficulty.expert: [
        (
            "009000000000067904270900080003819002080000010400673500050006041602740000000000600",
            "149528763835167924276934185563819472987452316421673598758396241612745839394281657",
        ),
        (
            "170050600009700004000400070608000050430060029010000406060002000800007500001040032",
            "174253698529786314386491275698124753437865129215379486963512847842937561751648932",
        ),
    ],
    Difficulty.master: [
        (
            "600500090020090000300007605090000743000000000736000080401200006000070020080006004",
            "678531492125694837349827615592168743814753269736942581451289376963475128287316954",
        ),
        (
            "000080000801407050007005000710500400360000021008001097000800900030104805000030000",
            "543286719821497653697315248719523486364978521258641397176852934932164875485739162",
        ),
    ],
    Difficulty.extreme: [
        (
            "504260800200000007010300000150000208000000000708000051000002070300000002001079406",
            "534267819289451367617398524153746298962185743748923651496832175375614982821579436",
        ),
        (
            "000010000089000410030408005304000090000382000050000103500807060062000980000060000",
            "245716839789523416136498275324651798917382654658974123591847362462135987873269541",
        ),
    ],
}


def _permutation_within_groups(rng: random.Random) -> list[int]:
    """A permutation of 0..8 that shuffles the three groups and the lines inside each."""
    groups = [0, 1, 2]
    rng.shuffle(groups)
    order: list[int] = []
    for g in groups:
        lines = [g * 3, g * 3 + 1, g * 3 + 2]
        rng.shuffle(lines)
        order.extend(lines)
    return order


def _transform(givens: str, solution: str, rng: random.Random) -> tuple[str, str]:
    """Apply one random validity-preserving symmetry (relabel, row/col shuffles, transpose).

    Used only to give the fixture source effectively unlimited distinct puzzles.
    """
    digits = list("123456789")
    rng.shuffle(digits)
    relabel = {"0": "0"} | {str(i + 1): d for i, d in enumerate(digits)}
    rows = _permutation_within_groups(rng)
    cols = _permutation_within_groups(rng)
    transpose = rng.random() < 0.5

    def apply(grid: str) -> str:
        out: list[str] = []
        for r in range(9):
            for c in range(9):
                rr, cc = rows[r], cols[c]
                if transpose:
                    rr, cc = cc, rr
                out.append(relabel[grid[rr * 9 + cc]])
        return "".join(out)

    return apply(givens), apply(solution)


class FixturePuzzleSource:
    """Hand-picked, truthfully rated puzzles for development and tests.

    With `transform=True` (default) every call returns a randomly relabelled/shuffled
    variant, so the pool can be filled without duplicate `givens`. Every variant is re-rated;
    if a variant's level ever differed from the requested one, the base puzzle is used.
    """

    generator_version = "fixture-2"

    def __init__(
        self,
        seed: int | None = None,
        *,
        transform: bool = True,
        fixtures: Mapping[Difficulty, Sequence[tuple[str, str]]] | None = None,
    ) -> None:
        self._rng = random.Random(seed)  # noqa: S311 - not security sensitive
        self._transform = transform
        self._fixtures = _FIXTURES if fixtures is None else fixtures
        self._counters: dict[Difficulty, int] = {}
        self._lock = threading.Lock()  # shared by the pool worker and request threads

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        del timeout  # instant
        options = self._fixtures.get(difficulty) or []
        if not options:
            raise NoPuzzleAvailableError(f"no fixture puzzles for {difficulty}")
        with self._lock:
            n = self._counters.get(difficulty, 0)
            self._counters[difficulty] = n + 1
            base = options[n % len(options)]
            candidates = [_transform(*base, self._rng)] if self._transform else []
        for givens, solution in [*candidates, base]:
            rating = puzzle_logic.rate(puzzle_logic.parse(givens))
            if puzzle_logic.rated_difficulty(rating) == difficulty:
                return SourcePuzzle(
                    givens, solution, difficulty, rating.score, dict(rating.techniques), None
                )
        # Only reachable if a fixture is mislabelled; the insertion gate rejects it anyway.
        givens, solution = base
        return SourcePuzzle(givens, solution, difficulty, 0, {}, None)


def generate_source_puzzle(
    difficulty: Difficulty, seed: int | None, timeout: float | None
) -> SourcePuzzle:
    """Module-level (picklable) generator call; runs in a worker process or thread."""
    try:
        p = puzzle_logic.generate(difficulty, seed=seed, timeout=timeout)
    except puzzle_logic.GenerationError as exc:
        raise PuzzleGenerationError(str(exc)) from None
    return SourcePuzzle(
        givens=puzzle_logic.format_grid(p.givens),
        solution=puzzle_logic.format_grid(p.solution),
        difficulty=Difficulty(str(p.difficulty)),
        rating_score=p.rating.score,
        techniques=dict(p.rating.techniques),
        seed=p.seed,
    )


class GeneratorPuzzleSource:
    """Uses `sudoku_generator.generate` through the puzzle-logic adapter.

    With `seed` set, per-puzzle seeds are drawn from a seeded RNG in the calling process, so a
    run is reproducible (tests); otherwise the generator picks a fresh random seed each time.
    The seed used is stored with every puzzle.
    """

    generator_version = puzzle_logic.GENERATOR_VERSION

    def __init__(self, seed: int | None = None) -> None:
        self._rng = None if seed is None else random.Random(seed)  # noqa: S311

    def _next_seed(self) -> int | None:
        return None if self._rng is None else self._rng.getrandbits(63)

    def job(
        self, difficulty: Difficulty, timeout: float | None = None
    ) -> Callable[[], SourcePuzzle]:
        return partial(generate_source_puzzle, difficulty, self._next_seed(), timeout)

    def get(self, difficulty: Difficulty, timeout: float | None = None) -> SourcePuzzle:
        return self.job(difficulty, timeout)()


def make_puzzle_source(settings: Settings) -> PuzzleSource:
    if settings.puzzle_source == "generator":
        return GeneratorPuzzleSource()
    return FixturePuzzleSource()
