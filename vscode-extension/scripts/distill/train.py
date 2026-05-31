"""Distill a small seq2seq model on collected prompt-rewriting pairs.

Inputs:
  --data   Path to a JSONL file. Each line: {"input": "...", "output": "..."}.
  --base   Hugging Face base model id (default: google/flan-t5-small).
  --out    Output directory for the trained model.

Example:
  python train.py \\
      --data ../../training-data/training-pairs.jsonl \\
      --base google/flan-t5-small \\
      --out  ../../.distill-work
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import Dataset
from transformers import (
    AutoModelForSeq2SeqLM,
    AutoTokenizer,
    DataCollatorForSeq2Seq,
    Seq2SeqTrainer,
    Seq2SeqTrainingArguments,
)

INSTRUCTION = (
    "Rewrite this prompt to be clearer, more specific, and structured "
    "with explicit constraints:\n\n"
)


def load_jsonl(path: Path) -> Dataset:
    rows: list[dict[str, str]] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            inp = (obj.get("input") or "").strip()
            out = (obj.get("output") or "").strip()
            if inp and out and inp != out:
                rows.append({"input": INSTRUCTION + inp, "output": out})
    if not rows:
        raise SystemExit(f"No usable training rows found in {path}.")
    return Dataset.from_list(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--base", default="google/flan-t5-small")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--bs", type=int, default=8)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--max_in", type=int, default=512)
    parser.add_argument("--max_out", type=int, default=256)
    args = parser.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = AutoModelForSeq2SeqLM.from_pretrained(args.base)
    dataset = load_jsonl(args.data)

    def encode(batch: dict[str, list[str]]) -> dict[str, list[int]]:
        enc = tokenizer(
            batch["input"], max_length=args.max_in, truncation=True, padding=False
        )
        with tokenizer.as_target_tokenizer():
            lbl = tokenizer(
                batch["output"], max_length=args.max_out, truncation=True, padding=False
            )
        enc["labels"] = lbl["input_ids"]
        return enc

    dataset = dataset.map(encode, batched=True, remove_columns=dataset.column_names)
    eval_size = 0.05 if len(dataset) >= 40 else max(1, len(dataset) // 10) / len(dataset)
    split = dataset.train_test_split(test_size=eval_size, seed=42)

    args.out.mkdir(parents=True, exist_ok=True)
    training_args = Seq2SeqTrainingArguments(
        output_dir=str(args.out),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bs,
        per_device_eval_batch_size=args.bs,
        learning_rate=args.lr,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=1,
        predict_with_generate=True,
        fp16=False,
        logging_steps=20,
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        model=model,
        args=training_args,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        tokenizer=tokenizer,
        data_collator=DataCollatorForSeq2Seq(tokenizer, model=model),
    )
    trainer.train()

    final_dir = args.out / "final"
    trainer.save_model(str(final_dir))
    tokenizer.save_pretrained(str(final_dir))
    print(f"Distilled model saved to {final_dir}")


if __name__ == "__main__":
    main()
