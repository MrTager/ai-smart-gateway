import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import path from "node:path";

export const initialState = () => ({
  models: [
    {
      id: "demo-planner",
      name: "深度决策模型",
      kind: "demo",
      model: "demo-reasoner",
      baseUrl: "",
      maxTokens: 2048,
      tokenParameter: "max_tokens",
      temperature: 0.2,
      timeoutMs: 60000,
      jsonMode: false,
      inputPrice: null,
      outputPrice: null,
    },
    {
      id: "demo-fast",
      name: "快速执行模型",
      kind: "demo",
      model: "demo-fast",
      baseUrl: "",
      maxTokens: 2048,
      tokenParameter: "max_tokens",
      temperature: 0.4,
      timeoutMs: 60000,
      jsonMode: false,
      inputPrice: null,
      outputPrice: null,
    },
    {
      id: "demo-writer",
      name: "轻量写作模型",
      kind: "demo",
      model: "demo-writer",
      baseUrl: "",
      maxTokens: 2048,
      tokenParameter: "max_tokens",
      temperature: 0.5,
      timeoutMs: 60000,
      jsonMode: false,
      inputPrice: null,
      outputPrice: null,
    },
  ],
  strategy: {
    mode: "strategy",
    plannerId: "demo-planner",
    executorIds: ["demo-fast", "demo-writer"],
    reviewerId: "",
    maxSteps: 4,
    concurrency: 2,
    review: false,
    plannerPrompt: "制定简洁、可验证的计划。只传递与当前子任务相关的上下文。",
  },
  runs: [],
});

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const keyPath = path.join(this.directory, "secret.key");
    try {
      this.key = await readFile(keyPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.key = randomBytes(32);
      await writeFile(keyPath, this.key, { mode: 0o600, flag: "wx" });
    }
    if (this.key.length !== 32) throw new Error("Invalid local encryption key");
    await chmod(keyPath, 0o600);
    try {
      this.state = JSON.parse(
        await readFile(path.join(this.directory, "state.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = initialState();
    }
    for (const run of this.state.runs) {
      if (["queued", "running"].includes(run.status)) {
        run.status = "failed";
        run.error = "服务重启，任务已中断，请手动重试。";
        run.finishedAt = new Date().toISOString();
      }
    }
    await this.save();
    return this;
  }
  encrypt(value) {
    if (!value) return "";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
  }
  decrypt(value) {
    if (!value) return "";
    const buffer = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      buffer.subarray(0, 12),
    );
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([
      decipher.update(buffer.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }
  publicConfig() {
    return {
      models: this.state.models.map(({ encryptedKey, ...model }) => ({
        ...model,
        hasKey: Boolean(encryptedKey),
      })),
      strategy: structuredClone(this.state.strategy),
    };
  }
  save() {
    const serialized = JSON.stringify(this.state, null, 2);
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const temporary = path.join(
          this.directory,
          `.state-${randomUUID()}.tmp`,
        );
        await writeFile(temporary, serialized, { mode: 0o600 });
        await rename(temporary, path.join(this.directory, "state.json"));
      });
    this.queue = operation;
    return operation;
  }
}
