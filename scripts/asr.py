import sys
import os
import argparse


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--models", default="")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type="int8",
        download_root=args.models or None,
    )
    segs, info = model.transcribe(
        args.audio,
        language="zh",
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        initial_prompt="以下是一段关于 AI 编程、智能体、工作流、软件工程的中文技术直播。",
        beam_size=1,
        condition_on_previous_text=False,
    )
    lines = []
    for s in segs:
        t = int(s.start)
        lines.append(f"[{t // 60:02d}:{t % 60:02d}] {s.text.strip()}")
    text = "\n".join(lines) + "\n"
    # out = "-" 时走 stdout：某些机器上 python 子进程写不了用户目录（沙箱令牌），
    # 让 node 落盘更稳；进度信息一律走 stderr，别污染 stdout。
    if args.out == "-":
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdout.write(text)
        sys.stdout.flush()
        print(f"OK {len(lines)} segments -> stdout", file=sys.stderr)
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"OK {len(lines)} segments -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
