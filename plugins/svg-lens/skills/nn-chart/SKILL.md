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
3. **파이프라인 요약(`<metadata id="nn-summary">`), 칩 호버 툴팁(`<metadata id="nn-tips">`) 및 자연어 해설 마크다운(`README.md`) 생성**:
   - `chart.svg`의 `</svg>` 직전에 모델 전체를 4~8개 상위 단계로 요약한 JSON을 `<metadata id="nn-summary">{"title": "...", "stages": [{"title": "1. ...", "summary": "...", "match": "<컨테이너 제목 부분문자열>"}]}</metadata>` 형식으로 삽입합니다.
   - 같은 위치에 `gt`, `any`, `getitem[:,None]` 등 저수준 연산 칩의 의미와 원본 코드를 설명하는 `<metadata id="nn-tips">{"chips": {"<칩 텍스트>": {"meaning": "<한글 1줄 역할>", "code": "<원본 코드 1줄>", "io": "<입출력 의미>"}}}</metadata>`도 함께 삽입합니다.
   - 이 메타데이터가 있으면 뷰어가 줌아웃(`LOD`) · `Modules` 목차에서 단계별 요약을 보여주고, 개별 칩에 마우스를 올릴 때 호버 툴팁으로 역할과 원본 코드를 띄웁니다.
   - `<출력_디렉토리>/README.md` 파일도 함께 생성하여 읽기 쉬운 한국어 문서로 출력합니다. 반드시 아래 항목을 포함합니다:
     1. **모델 한눈에 보기**: 무엇을 예측하는 모델인지 1~2문장 요약
     2. **입력 데이터 명세**: 차트의 모든 입력 레인(`입력 레인 · <이름>`)별로 shape과 실제 의미/역할 표 또는 설명
     3. **모델의 핵심 특징**: 이 아키텍처만의 차별점(예: 백본 동결, 결측 모달리티 마스크 처리, 3D 부피 적분, 물리 제약 헤드 등)
     4. **최종 출력**: 모델이 반환하는 텐서/예측값 목록
     5. **전체 파이프라인 쉬운 해설 (처음부터 끝까지 빠짐없이)**: 각 입력이 들어와서 전처리/마스크 검사를 거쳐 여러 갈래(백본·공간 풀링·보조 문맥 등)로 나뉘고, 어디서 다시 합쳐져 어떤 헤드(주 출력 + 보조/학습용 헤드)로 나가는지 **분기와 합류를 하나도 빠뜨리지 않고** 비전문가도 이해할 수 있는 자연어 줄글로 풀어씁니다(길어져도 무방).
     6. **단계별 위치 키워드 & 세부 텐서 조작 해설**: `nn-summary` 단계별 요약, `gt`/`any`/`getitem` 등 보조 연산 의도, `report.json` 기반 병목·진단 요약(예: 스케일불균형, 합류비중, CKA 등)
4. **응답 시 `SVG Lens` 뷰어 설치·열람 안내 (필수)**:
   - 생성된 `chart.svg`는 가로 수만~십수만 픽셀의 초대형 SVG이므로, 최종 답변에서 사용자에게 **VS Code 확장 `SVG Lens`** (`Claude-Plugins/plugins/svg-lens/viewer/svg-lens-0.1.1.vsix`)를 `Extensions → ... → Install from VSIX...`로 설치한 뒤 `chart.svg`를 열어 **칩 호버 툴팁 · `LOD`(시맨틱 줌) · `Modules`(단계 요약 목차) · `Collapse`(블록 접기/펼치기) · `Issues`(병목 점프)**로 탐색할 수 있음을 반드시 안내합니다.

---

## `README.md` 내 `?` 마커 질문 처리 규칙
- 매번 `README.md`를 자동으로 읽거나 감시하지 않고, **사용자가 `nn-chart` 출력 `README.md` 파일을 직접 전달·지목한 경우에만** 확인합니다.
- 먼저 해당 `README.md`의 **`git diff`를 읽어** 사용자가 어느 줄/구간에 `?`나 질의를 새로 달았는지 정확히 특정합니다 (`temp/` 등 git 추적 밖 파일이거나 diff가 없을 때만 파일 내 `?` 마커를 직접 탐색).
- diff로 확인된 `?`·질의 부분마다 `chart.svg`·`report.json`·모델 코드를 근거로 **두 곳에 동시에 답합니다**:
  1. **채팅 응답**: 핵심만 **짧고 명확하게** 설명
  2. **`README.md` 파일 수정**: 해당 `?` 바로 뒤에 **길지 않게(1~2문장 이내)** 인라인 답을 달아둠 (예: `... ? -> **답**: ...`)
