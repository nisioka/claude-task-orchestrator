import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepositoryConfig } from "../repositories.js";

// ─── Mocks ──────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  access: vi.fn(),
}));

import { readFile, access } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);
const mockAccess = vi.mocked(access);

// ─── Helpers ────────────────────────────────────────────────────────

function validConfig() {
  return JSON.stringify({
    repositories: [
      {
        label: "my-repo",
        path: "/home/user/projects/my-repo",
        baseBranch: "main",
      },
    ],
  });
}

function validConfigWithOptionalFields() {
  return JSON.stringify({
    repositories: [
      {
        label: "my-repo",
        path: "/home/user/projects/my-repo",
        baseBranch: "main",
        setupPrompt: "Run npm install first",
        cleanupPrompt: "Run npm run clean",
      },
    ],
  });
}

function multiRepoConfig() {
  return JSON.stringify({
    repositories: [
      {
        label: "repo-a",
        path: "/home/user/projects/repo-a",
        baseBranch: "main",
      },
      {
        label: "repo-b",
        path: "/home/user/projects/repo-b",
        baseBranch: "develop",
        setupPrompt: "Setup B",
      },
    ],
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("loadRepositoryConfig", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockAccess.mockReset();
    mockAccess.mockResolvedValue(undefined);
  });

  it("loads valid config successfully", async () => {
    mockReadFile.mockResolvedValueOnce(validConfig());

    const { loadRepositoryConfig } = await import("../repositories.js");
    const config = await loadRepositoryConfig("/path/to/config.json");

    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0]).toEqual({
      label: "my-repo",
      path: "/home/user/projects/my-repo",
      baseBranch: "main",
      setupPrompt: undefined,
      cleanupPrompt: undefined,
    });
  });

  it("throws when config file is not found", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file or directory"));

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/nonexistent/config.json")).rejects.toThrow(
      "設定ファイルを読み込めません: /nonexistent/config.json",
    );
  });

  it("throws when JSON is invalid", async () => {
    mockReadFile.mockResolvedValueOnce("{ invalid json }}}");

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/bad.json")).rejects.toThrow(
      "設定ファイルのJSONが不正です: /path/to/bad.json",
    );
  });

  it("throws when repositories array is missing", async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ other: "data" }));

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      "設定ファイルに repositories 配列がありません",
    );
  });

  it("throws when repositories is empty", async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ repositories: [] }));

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      "repositories が空です。少なくとも1つのリポジトリマッピングが必要です",
    );
  });

  it("throws when label is missing", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [{ path: "/some/path", baseBranch: "main" }],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      "各リポジトリマッピングには label (文字列) が必要です",
    );
  });

  it("throws when path is missing", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [{ label: "my-repo", baseBranch: "main" }],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      'リポジトリマッピング "my-repo" に path が必要です',
    );
  });

  it("throws when baseBranch is missing", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [{ label: "my-repo", path: "/some/path" }],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      'リポジトリマッピング "my-repo" に baseBranch が必要です',
    );
  });

  it("throws when labels are duplicated", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [
          { label: "dup", path: "/path/a", baseBranch: "main" },
          { label: "dup", path: "/path/b", baseBranch: "main" },
        ],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      'ラベル "dup" が重複しています',
    );
  });

  it("throws when repository path does not exist", async () => {
    mockReadFile.mockResolvedValueOnce(validConfig());
    mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

    const { loadRepositoryConfig } = await import("../repositories.js");

    await expect(loadRepositoryConfig("/path/to/config.json")).rejects.toThrow(
      "リポジトリパスが存在しません: /home/user/projects/my-repo (ラベル: my-repo)",
    );
  });

  it("handles optional setupPrompt and cleanupPrompt correctly", async () => {
    mockReadFile.mockResolvedValueOnce(validConfigWithOptionalFields());

    const { loadRepositoryConfig } = await import("../repositories.js");
    const config = await loadRepositoryConfig("/path/to/config.json");

    expect(config.repositories[0].setupPrompt).toBe("Run npm install first");
    expect(config.repositories[0].cleanupPrompt).toBe("Run npm run clean");
  });

  it("loads multiple repositories", async () => {
    mockReadFile.mockResolvedValueOnce(multiRepoConfig());

    const { loadRepositoryConfig } = await import("../repositories.js");
    const config = await loadRepositoryConfig("/path/to/config.json");

    expect(config.repositories).toHaveLength(2);
    expect(config.repositories[0].label).toBe("repo-a");
    expect(config.repositories[1].label).toBe("repo-b");
    expect(config.repositories[1].setupPrompt).toBe("Setup B");
    expect(config.repositories[1].cleanupPrompt).toBeUndefined();
  });
});

describe("findRepositoryByLabel", () => {
  const config: RepositoryConfig = {
    repositories: [
      { label: "alpha", path: "/path/alpha", baseBranch: "main" },
      { label: "beta", path: "/path/beta", baseBranch: "develop", setupPrompt: "npm ci" },
    ],
  };

  it("returns matching repository", async () => {
    const { findRepositoryByLabel } = await import("../repositories.js");

    const result = findRepositoryByLabel(config, "beta");

    expect(result).toEqual({
      label: "beta",
      path: "/path/beta",
      baseBranch: "develop",
      setupPrompt: "npm ci",
    });
  });

  it("returns undefined when label not found", async () => {
    const { findRepositoryByLabel } = await import("../repositories.js");

    const result = findRepositoryByLabel(config, "nonexistent");

    expect(result).toBeUndefined();
  });

});

// ─── Orchestrator additions (requirement 15.1) ──────────────────────

describe("orchestrator repository settings", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockAccess.mockReset();
    mockAccess.mockResolvedValue(undefined);
  });

  it("reads the optional setup command, branch prefix, local patch and model", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [
          {
            label: "app-be",
            path: "/home/user/projects/app-be",
            baseBranch: "develop",
            setupCommand: "app-be-gw",
            branchPrefix: "feat/",
            localPatch: "/home/user/WSL_local.patch",
            model: "opus",
          },
        ],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");
    const [repo] = (await loadRepositoryConfig("/path/to/config.json")).repositories;

    expect(repo.setupCommand).toBe("app-be-gw");
    expect(repo.branchPrefix).toBe("feat/");
    expect(repo.localPatch).toBe("/home/user/WSL_local.patch");
    expect(repo.model).toBe("opus");
  });

  it("stays backward compatible: a config without them still loads", async () => {
    mockReadFile.mockResolvedValueOnce(validConfig());

    const { loadRepositoryConfig } = await import("../repositories.js");
    const [repo] = (await loadRepositoryConfig("/path/to/config.json")).repositories;

    expect(repo.setupCommand).toBeUndefined();
    expect(repo.branchPrefix).toBeUndefined();
    expect(repo.localPatch).toBeUndefined();
    expect(repo.model).toBeUndefined();
  });

  it("ignores values of the wrong type rather than failing the whole config", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({
        repositories: [
          {
            label: "odd",
            path: "/home/user/projects/odd",
            baseBranch: "main",
            branchPrefix: 42,
            model: null,
          },
        ],
      }),
    );

    const { loadRepositoryConfig } = await import("../repositories.js");
    const [repo] = (await loadRepositoryConfig("/path/to/config.json")).repositories;

    expect(repo.branchPrefix).toBeUndefined();
    expect(repo.model).toBeUndefined();
  });
});
