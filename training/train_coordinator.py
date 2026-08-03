import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--qlora", action="store_true")
    parser.add_argument("--epochs", type=float, default=4)
    parser.add_argument("--max-length", type=int, default=1024)
    parser.add_argument("--minimum-schema-rate", type=float, default=0.90)
    parser.add_argument(
        "--minimum-primary-model-accuracy", type=float, default=0.70
    )
    return parser.parse_args()


def parse_json_object(text):
    start = text.find("{")
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[start:])[0]
    except (json.JSONDecodeError, TypeError):
        return None


def schema_valid(value):
    roles = {"general", "analyst", "implementer", "reviewer"}
    step_roles = {"analyst", "implementer", "reviewer"}
    if not isinstance(value, dict) or set(value) != {
        "version",
        "tier",
        "primary",
        "steps",
        "confidence",
    }:
        return False
    if value["version"] != 1 or value["tier"] not in {"simple", "moderate", "high"}:
        return False
    primary = value["primary"]
    if (
        not isinstance(primary, dict)
        or set(primary) != {"role", "model"}
        or primary["role"] not in roles
        or not isinstance(primary["model"], str)
        or not primary["model"]
    ):
        return False
    confidence = value["confidence"]
    if (
        isinstance(confidence, bool)
        or not isinstance(confidence, (int, float))
        or not 0 <= confidence <= 1
    ):
        return False
    steps = value["steps"]
    if not isinstance(steps, list) or len(steps) > 2:
        return False
    for step in steps:
        if (
            not isinstance(step, dict)
            or set(step) != {"role", "model", "instruction", "access"}
            or step["role"] not in step_roles
            or not isinstance(step["model"], str)
            or not step["model"]
            or not isinstance(step["instruction"], str)
            or len(step["instruction"]) < 8
            or not isinstance(step["access"], list)
            or any(
                isinstance(index, bool) or not isinstance(index, int) or index < 0
                for index in step["access"]
            )
        ):
            return False
    return True


def evaluate_routing(model, tokenizer, validation, max_length):
    counts = {
        "examples": 0,
        "schema_valid": 0,
        "tier_match": 0,
        "primary_role_match": 0,
        "primary_model_match": 0,
        "step_models_exact": 0,
    }
    device = model.get_input_embeddings().weight.device
    model.eval()
    for example in validation:
        messages = example["messages"]
        prompt = tokenizer.apply_chat_template(
            messages[:-1], tokenize=False, add_generation_prompt=True
        )
        encoded = tokenizer(
            prompt,
            truncation=True,
            max_length=max_length,
            add_special_tokens=False,
            return_tensors="pt",
        ).to(device)
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                max_new_tokens=384,
                do_sample=False,
                pad_token_id=tokenizer.pad_token_id,
                eos_token_id=tokenizer.eos_token_id,
            )
        new_tokens = generated[0, encoded["input_ids"].shape[1] :]
        predicted = parse_json_object(
            tokenizer.decode(new_tokens, skip_special_tokens=True)
        )
        target = json.loads(messages[-1]["content"])
        counts["examples"] += 1
        if not schema_valid(predicted):
            continue
        counts["schema_valid"] += 1
        counts["tier_match"] += int(predicted["tier"] == target["tier"])
        counts["primary_role_match"] += int(
            predicted["primary"]["role"] == target["primary"]["role"]
        )
        counts["primary_model_match"] += int(
            predicted["primary"]["model"] == target["primary"]["model"]
        )
        counts["step_models_exact"] += int(
            [step["model"] for step in predicted["steps"]]
            == [step["model"] for step in target["steps"]]
        )
    denominator = max(1, counts["examples"])
    return {
        **counts,
        "schema_valid_rate": counts["schema_valid"] / denominator,
        "tier_accuracy": counts["tier_match"] / denominator,
        "primary_role_accuracy": counts["primary_role_match"] / denominator,
        "primary_model_accuracy": counts["primary_model_match"] / denominator,
        "step_models_exact_rate": counts["step_models_exact"] / denominator,
    }


def main():
    args = parse_args()
    data_dir = Path(args.data_dir)
    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    quantization = None
    if args.qlora:
        quantization = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16,
        quantization_config=quantization,
        device_map="auto",
    )
    if args.qlora:
        model = prepare_model_for_kbit_training(model)
    peft = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules="all-linear",
    )
    from peft import get_peft_model

    model = get_peft_model(model, peft)
    model.print_trainable_parameters()
    dataset = load_dataset(
        "json",
        data_files={
            "train": str(data_dir / "train.jsonl"),
            "validation": str(data_dir / "validation.jsonl"),
        },
    )

    def tokenize(example):
        messages = example["messages"]
        prompt = tokenizer.apply_chat_template(
            messages[:-1], tokenize=False, add_generation_prompt=True
        )
        full = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )
        encoded = tokenizer(
            full,
            truncation=True,
            max_length=args.max_length,
            add_special_tokens=False,
        )
        prompt_ids = tokenizer(
            prompt,
            truncation=True,
            max_length=args.max_length,
            add_special_tokens=False,
        )["input_ids"]
        labels = list(encoded["input_ids"])
        labels[: min(len(prompt_ids), len(labels))] = [-100] * min(
            len(prompt_ids), len(labels)
        )
        encoded["labels"] = labels
        return encoded

    tokenized = dataset.map(
        tokenize,
        remove_columns=dataset["train"].column_names,
        desc="Tokenizing coordinator examples",
    )
    training = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        learning_rate=2e-4,
        per_device_train_batch_size=8,
        per_device_eval_batch_size=8,
        gradient_accumulation_steps=2,
        warmup_ratio=0.05,
        weight_decay=0.01,
        lr_scheduler_type="cosine",
        bf16=True,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        report_to=[],
        seed=42,
    )
    trainer = Trainer(
        model=model,
        args=training,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized["validation"],
        data_collator=DataCollatorForSeq2Seq(
            tokenizer=tokenizer,
            padding=True,
            label_pad_token_id=-100,
            return_tensors="pt",
        ),
    )
    trainer.train()
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    metrics = trainer.evaluate()
    routing_metrics = evaluate_routing(
        model, tokenizer, dataset["validation"], args.max_length
    )
    metrics["routing"] = routing_metrics
    Path(args.output_dir, "training_metrics.json").write_text(
        json.dumps(metrics, indent=2) + "\n", encoding="utf-8"
    )
    if routing_metrics["schema_valid_rate"] < args.minimum_schema_rate:
        raise RuntimeError(
            "Coordinator failed held-out schema gate: "
            f"{routing_metrics['schema_valid_rate']:.3f} < "
            f"{args.minimum_schema_rate:.3f}"
        )
    if (
        routing_metrics["primary_model_accuracy"]
        < args.minimum_primary_model_accuracy
    ):
        raise RuntimeError(
            "Coordinator failed held-out routing gate: "
            f"{routing_metrics['primary_model_accuracy']:.3f} < "
            f"{args.minimum_primary_model_accuracy:.3f}"
        )


if __name__ == "__main__":
    main()
