# Training data and font licenses

The cell classifier (`src/sudoku_vision/models/digits.onnx`) is trained by
`scripts/train.py` on the data below. Nothing here is committed: everything is
downloaded into `vision/.cache/` (gitignored) by `scripts/data_sources.py` and
verified against the SHA-256 values pinned in that file. Downloads are data
only and are never executed.

## Handwritten digits: MNIST

- **What:** the MNIST database of handwritten digits (60,000 training and 10,000 test images).
- **Source:** the torchvision mirror `https://ossci-datasets.s3.amazonaws.com/mnist/`. The four
  `*-ubyte.gz` files match torchvision's published MD5 checksums, and SHA-256 is pinned in
  `scripts/data_sources.py`.
- **Authors:** Yann LeCun, Corinna Cortes and Christopher J.C. Burges. MNIST is derived from NIST
  Special Databases 1 and 3.
- **Original page:** `http://yann.lecun.com/exdb/mnist/`.
- **License: unclear, so treat it as attribution-required and flag it before any public release.**
  Checked on 2026-11-20:
  - The original page states **no license**. Archived copies from 2015 and 2021 contain no
    license or copyright text, and the URL now serves only a bare directory listing.
  - The mirror we download from (the torchvision S3 bucket) contains only the four data files and
    states no license.
  - The Hugging Face dataset card `ylecun/mnist` declares `license: mit`.
  - "CC BY-SA 3.0" is often repeated in third-party catalogues, but we could not trace it to the
    authors or to the mirror. An earlier version of this file wrongly said the original page
    states it.
  - We therefore credit the authors everywhere the data is used (here, in
    `src/sudoku_vision/models/digits.json` and in `src/sudoku_vision/models/LICENSES.md`), and
    we make no stronger license claim.
- **Use:**
  - The training split is used for training.
  - The test split is used for validation, the benchmark and the committed test fixtures.
  - The fixtures (`tests/fixtures/*.jpg`) contain rendered MNIST test digits, so they carry the
    same attribution: MNIST, by Yann LeCun, Corinna Cortes and Christopher J.C. Burges.

## Printed digits: OFL fonts

All fonts come from the Google Fonts repository at a pinned commit:
`https://github.com/google/fonts/tree/cc5661d43cd4f9aad5567033a8e15ca28dc35c86/ofl/`.
They are licensed under the **SIL Open Font License 1.1**. Each family's `OFL.txt`, with its
copyright notice, is downloaded next to the font into `.cache/fonts/<family>/`.

| Family | Files | Copyright (from OFL.txt) |
|---|---|---|
| Lato | Lato-Regular, Lato-Bold | Łukasz Dziedzic (tyPoland) |
| Fira Sans | FiraSans-Regular, FiraSans-Bold | The Mozilla Foundation and Telefonica S.A. |
| PT Serif | PT_Serif-Web-Regular, PT_Serif-Web-Bold | ParaType Ltd. |
| Courier Prime | CourierPrime-Regular, CourierPrime-Bold | The Courier Prime Project Authors |
| Merriweather | Merriweather[opsz,wdth,wght] | The Merriweather Project Authors |
| Source Serif 4 | SourceSerif4[opsz,wght] | The Source Serif 4 Project Authors |
| Noto Sans | NotoSans[wdth,wght] | The Noto Project Authors |
| Open Sans | OpenSans[wdth,wght] | The Open Sans Project Authors |
| Oswald | Oswald[wght] | The Oswald Project Authors |
| Libre Baskerville | LibreBaskerville[wght] | The Libre Baskerville Project Authors |
| Roboto Mono | RobotoMono[wght] | The Roboto Mono Project Authors |
| Archivo | Archivo[wdth,wght] | The Archivo Project Authors |

The fonts are used only to render training and test images. No font file is redistributed.

## Model

The model weights are learned from the data above. The attribution travels with the model:

- `src/sudoku_vision/models/digits.json` has a `licenses` block covering the MNIST authors,
  source and license status, and the font families and their license.
- `src/sudoku_vision/models/LICENSES.md` is a verbatim copy of this file. It ships in the wheel
  and the Docker image next to the model, and a test keeps the two identical.
