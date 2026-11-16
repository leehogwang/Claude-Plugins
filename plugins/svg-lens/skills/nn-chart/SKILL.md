---
name: nn-chart
description: PyTorch 신경망 모델을 실제 forward 실행 트레이스로 100% 누락 없이 계층형 상태차트(SVG)로 시각화하고, 5단계 근거 기반 병목 진단(스케일불균형, 합류비중, 게이트쏠림, 초기기울기막힘, 가중치유효랭크, 죽은 뉴런측정, 다중손실기울기충돌, CKA 중심 커널 정렬도, 5-Fold 교차검증 잔차프로빙)을 자동으로 표시합니다. 트리거: "nn-chart", "nn_chart", "모델 구조 시각화", "모델 다이어그램", "신경망 차트", "병목 진단 차트", "아키텍처 SVG"
---

# nn-chart (Execution-Traced Neural Network Architecture & Diagnostics Visualizer)

PyTorch 모델을 한 번 실제 실행(`__torch_function__` + module hook)하여 **모든 연산·간선·텐서 차원·파라미터 수·가중치 고정(`requires_grad=False`) 구간**을 100% 누락 없이 추출하고, ELK 계층 레이아웃과 5단계 병목 진단이 포함된 단일 `chart.svg`를 생성합니다.

## 설치된 경로 및 실행 명령

- 레포지토리: `/home/leehogwang/Food-Nutrition-Estimation/tools/nn_chart`
- 메인 스크립트: `/home/leehogwang/Food-Nutrition-Estimation/tools/nn_chart/nn_chart.py`
- 가상환경 파이썬: `/home/leehogwang/Food-Nutrition-Estimation/.venv/bin/python3` (프로젝트 의존성 `timm`, `pandas` 등이 포함되어 있으므로 우선 사용)

```bash
cd /home/leehogwang/Food-Nutrition-Estimation/tools/nn_chart
/home/leehogwang/Food-Nutrition-Estimation/.venv/bin/python3 nn_chart.py <어댑터_파이썬_파일.py> --out <출력_디렉토리> [--ckpt <체크포인트.pth>] [--labels <라벨파일.labels.ko.json>]
```
- `<어댑터_파이썬_파일>.labels.ko.json` 파일이 같은 경로에 있으면 `--labels`를 생략해도 자동으로 한국어 블록 제목과 부연설명을 불러옵니다.
- 결과물은 `<출력_디렉토리>/chart.svg` 및 `<출력_디렉토리>/report.json`으로 생성됩니다.

---

## 필수 작성 체크리스트 (절대 생략 금지)

차트가 날것의 파이썬 경로명(`group · forward (line ...)`)으로 흩어지지 않고, 깔끔한 의미 블록 + 단계별 배경색 + 한국어 설명으로 렌더링되려면 **반드시 아래 6가지를 모두 작성**해야 합니다:

1. **`SOURCE` 지정**: `model.forward`가 정의된 원본 파이썬 파일의 `Path` (줄 번호 기반 `VIEW` 매핑에 필수)
2. **`VIEW` 딕셔너리 정의**: `forward()` 내부의 전처리·후처리 줄 번호 `(시작줄, 끝줄)`과 하위 모듈 이름(`"bb"`, `"se"`, `"freq"`, `"gate"` 등)을 의미 단위 상위 컨테이너로 묶기
   - **주의**: 한 줄 안에서 서브모듈 호출 앞뒤로 텐서 연산(`.flatten()`, `.transpose()`, `torch.cat()` 등)이 함께 일어나면, 해당 줄 번호 `(줄, 줄)`과 서브모듈 이름을 **같은 `VIEW` 키**로 묶어야 컨테이너 순환(cycle) 해체가 발생하지 않습니다.
3. **`PHASES` 딕셔너리 정의**: 모든 최상위 컨테이너에 단계별 배경 색상 지정 (`"input"`, `"encoder"`, `"fusion"`, `"heads"`, `"loss"`, `"output"`)
4. **`INPUT_ICONS` 및 `TRAIN_ONLY` 정의**:
   - `INPUT_ICONS`: 각 입력 노드에 아이콘 부여 (`"image"`, `"depth"`, `"text"`, `"database"`, `"stats"`, `"gate"`)
   - `TRAIN_ONLY`: 보조 손실 헤드 등 학습 전용 컨테이너/출력 목록 (점선 테두리 표시)
5. **`loss_terms(model, args, out)` 함수 정의**: 다중 손실 항목이 있는 모델에서 `다중손실기울기충돌` (Pass 3) 진단을 수행하기 위해 각 손실 스칼라 텐서를 딕셔너리로 반환
6. **`<어댑터이름>.labels.ko.json` 작성**:
   - 어댑터 파일 옆에 `<어댑터이름>.labels.ko.json`을 반드시 생성합니다.
   - 먼저 라벨 없이 1회 실행해 `<출력_디렉토리>/report.json`을 확인하거나 컨테이너 목록을 파악한 뒤, 모든 최상위 컨테이너·하위 주요 블록·입출력(`input.*`, `output.*`)에 대해 `{"ko": "한국어 제목", "note": "역할과 처리 방식 부연설명"}`을 작성합니다.
   - **규칙**: `ko`와 `note` 문자열 안에는 아라비아 숫자(`0~9`)를 적지 마세요 (`check_labels_hier`가 숫자를 금지하며, 모든 차원·커널·반복 횟수·진단 수치는 트레이스에서 자동 표기됩니다. 예: `3개` 대신 `세 갈래`, `1인분` 대신 `일인분`, `Q1~Q5` 대신 `다섯 구간`).

---

## 어댑터 템플릿 예시

```python
from pathlib import Path
import torch
import torch.nn.functional as F

ROOT = Path("/home/leehogwang/Food-Nutrition-Estimation")
SOURCE = ROOT / "experiments/42_fused/src/quantity.py"
CKPT = ROOT / "experiments/42_fused/runs/q_best_forunseen_gt/best.pth"
TITLE = "한식 양(등급·배율) 추정 모델"
INPUT_NAMES = ["x (RGB+z depth)", "xc (bbox crop)", "ud (UniDepth)", "um (depth meta)", "hd", "c (category)", "scl (depth scalars)"]

def build_model():
    ...

def example_input():
    ...

def call(model, b):
    return model(b, torch.device("cpu"))

def loss_terms(model, args, out):
    lg, sc = out
    q_tgt = torch.tensor([2, 3], dtype=torch.long)
    lr_tgt = torch.tensor([0.0, 0.2], dtype=torch.float32)
    return {
        "양 등급 분류 손실 (output.0)": F.cross_entropy(lg.float(), q_tgt, label_smoothing=0.1),
        "연속 로그 배율 회귀 손실 (output.1)": F.mse_loss(sc.float(), lr_tgt),
    }

VIEW = {
    "image backbone (ConvNeXt-Tiny)": ["bb", (90, 94)],
    "freq + stage3 spatial-channel mixer": ["freq", "m1", "conv", "proj", "m2", (96, 98)],
    "UniDepth encoder | learned mask": ["denc", (99, 100)],
    "3-way adaptive gate fusion": ["gate", (101, 102)],
    "category + depth scalar concat": ["cemb", (103, 103)],
    "quantity class head": ["head"],
    "continuous log-ratio head": ["scale", (104, 104)],
}

PHASES = {
    "image backbone (ConvNeXt-Tiny)": "encoder",
    "freq + stage3 spatial-channel mixer": "encoder",
    "UniDepth encoder | learned mask": "encoder",
    "3-way adaptive gate fusion": "fusion",
    "category + depth scalar concat": "fusion",
    "quantity class head": "heads",
    "continuous log-ratio head": "heads",
}

INPUT_ICONS = {
    "input.x (RGB+z depth)": ["image", "depth"],
    "input.xc (bbox crop)": ["image"],
    "input.ud (UniDepth)": ["depth"],
    "input.um (depth meta)": ["stats"],
    "input.hd": ["gate"],
    "input.c (category)": ["database"],
    "input.scl (depth scalars)": ["stats"],
}
```

## 생성 후 검증 · 요약 메타데이터 삽입 및 뷰어 안내
1. `<출력_디렉토리>/report.json`에서 `"completeness": {"ok": true}` 및 `"dissolved_cycle_containers": []`인지 확인합니다 (`dissolved_cycle_containers`가 비어 있지 않다면 `VIEW`에서 서브모듈 앞뒤 줄 번호를 해당 서브모듈과 함께 묶어 순환을 제거합니다).
2. `.labels.ko.json` 검증을 통과하여 모든 컨테이너와 입출력에 한국어 제목과 설명이 들어갔는지 확인합니다.
3. **파이프라인 요약 메타데이터(`<metadata id="nn-summary">`) 삽입**:
   - `chart.svg`의 `</svg>` 직전에 모델 전체를 4~8개 상위 단계로 요약한 JSON을 `<metadata id="nn-summary">{"title": "...", "stages": [{"title": "1. ...", "summary": "...", "match": "<컨테이너 제목 부분문자열>"}]}</metadata>` 형식으로 삽입합니다.
   - 이 메타데이터가 있으면 뷰어가 줌아웃(`LOD`) 및 `Modules` 목차에서 `"입력 레인 · ..."` 대신 사람이 읽는 단계별 제목과 요약을 표시합니다.
4. **응답 시 `SVG Lens` 뷰어 설치·열람 안내 (필수)**:
   - 생성된 `chart.svg`는 가로 수만~십수만 픽셀의 초대형 SVG이므로, 최종 답변에서 사용자에게 **VS Code 확장 `SVG Lens`** (`Claude-Plugins/plugins/svg-lens/viewer/svg-lens-0.1.0.vsix`)를 `Extensions → ... → Install from VSIX...`로 설치한 뒤 `chart.svg`를 열어 **`Flow`(스텝별 실행 흐름 · 코드 줄 · 텐서/진단 인스펙터) · `LOD`(시맨틱 줌) · `Modules`(단계 요약 목차) · `Collapse`(블록 접기/펼치기) · `Issues`(병목 점프)**로 탐색할 수 있음을 반드시 안내합니다.

---

## Execution Flow (`Flow` 모드) 트레이스 연동 스키마

`SVG Lens` 뷰어는 `chart.svg`와 같은 디렉토리의 `chart.trace.json` / `trace.json` / `report.json` 또는 SVG 내부의 `<script type="application/json" id="nn-trace">`를 자동으로 읽어 **Python Tutor 스타일의 스텝 이동(`<<`, `< Prev`, `Next >`, `>>`, 슬라이더) + `SOURCE` 코드 줄 하이라이트 + 전문가용 텐서·5단계 병목 인스펙터**를 활성화합니다.

```json
{
  "source_code": "def forward(self, x):\n  ...",
  "steps": [
    {
      "step": 1,
      "line": 92,
      "node_id": "bb",
      "label": "image backbone (ConvNeXt-Tiny)",
      "module": "model.bb",
      "op": "ConvNeXt.forward",
      "phase": "encoder",
      "params": 27820128,
      "trainable_params": 27820128,
      "inputs": [
        { "name": "x", "shape": [2, 4, 384, 384], "dtype": "float32", "requires_grad": false, "min": -2.1, "max": 2.4, "mean": 0.01, "std": 0.98 }
      ],
      "outputs": [
        { "name": "feat", "shape": [2, 768, 12, 12], "dtype": "float32", "requires_grad": true, "min": -3.4, "max": 4.1, "mean": 0.04, "std": 0.72 }
      ],
      "diagnostics": {
        "effective_rank": "412 / 768",
        "dead_neurons": "0.8%",
        "init_grad_norm": "1.24e-2"
      },
      "issues": [
        { "severity": "mayBreak", "title": "Scale Imbalance", "detail": "..." }
      ]
    }
  ]
}
```
