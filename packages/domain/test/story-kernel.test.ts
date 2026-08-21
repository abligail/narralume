import { describe, expect, it } from "vitest";

import {
  DomainError,
  canAccessFact,
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";

describe("outline invariants", () => {
  it("builds stable materialized paths and enforces the hierarchy", () => {
    const book = createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "长夜",
      now,
    });
    const chapter = createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: book,
      kind: "chapter",
      ordinal: 0,
      title: "灯塔",
      now,
    });
    expect(chapter).toMatchObject({
      path: "/book/chapter-1",
      depth: 1,
      parentId: "book",
    });

    expect(() =>
      createOutlineNode({
        id: "volume-under-beat",
        projectId: "p1",
        parent: { ...chapter, kind: "beat" },
        kind: "volume",
        ordinal: 0,
        title: "非法",
        now,
      }),
    ).toThrow(DomainError);
  });
});

describe("canon invariants and visibility", () => {
  const hero = createCanonEntity({
    id: "hero",
    projectId: "p1",
    type: "character",
    name: "林昭",
    aliases: ["阿昭", "阿昭"],
    now,
  });

  it("normalizes entities and requires exactly one fact object", () => {
    expect(hero.aliases).toEqual(["阿昭"]);
    expect(() =>
      createCanonFact({
        id: "bad",
        projectId: "p1",
        subjectId: hero.id,
        predicate: "位置",
        objectEntityId: "harbor",
        value: "港口",
        sourceType: "manual",
        now,
      }),
    ).toThrow("exactly one of objectEntityId or value");
  });

  it("filters author secrets and character-specific knowledge", () => {
    const secret = createCanonFact({
      id: "secret",
      projectId: "p1",
      subjectId: hero.id,
      predicate: "真实身份",
      value: "王储",
      knowledgeScope: "author_secret",
      authority: "locked",
      sourceType: "manual",
      now,
    });
    const belief = createCanonFact({
      id: "belief",
      projectId: "p1",
      subjectId: hero.id,
      predicate: "怀疑对象",
      value: "船长",
      knowledgeScope: "character",
      knowledgeSubjectId: hero.id,
      authority: "confirmed",
      sourceType: "chapter",
      now,
    });
    expect(canAccessFact(secret, { audience: "reader" })).toBe(false);
    expect(canAccessFact(secret, { audience: "author" })).toBe(true);
    expect(
      canAccessFact(belief, { audience: "character", characterId: hero.id }),
    ).toBe(true);
    expect(
      canAccessFact(belief, { audience: "character", characterId: "other" }),
    ).toBe(false);
  });
});
