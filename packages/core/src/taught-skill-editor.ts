import type { SkillPlaybook, TaughtSkill } from "@rakazo/contracts";
import { formatSkillRunPrompt } from "./teach-playbook.js";

export function taughtSkillRoutineSeed(skill: TaughtSkill, botId: string) {
  if (skill.botId !== botId || skill.status !== "saved") return null;
  const name = skill.name || skill.goal.slice(0, 80);
  return { name, prompt: formatSkillRunPrompt(name, skill.playbook) };
}

/** Transport boundary shared by taught-computer clients; never uses agentSkills. */
export type TaughtSkillTransport = {
  list: () => Promise<TaughtSkill[]>;
  start: (goal: string) => Promise<TaughtSkill>;
  stop: (skillId: string) => Promise<TaughtSkill>;
  update: (skillId: string, name: string, playbook: SkillPlaybook) => Promise<TaughtSkill>;
  save: (skillId: string, name: string) => Promise<TaughtSkill>;
  get: (skillId: string) => Promise<TaughtSkill>;
  test: (skillId: string) => Promise<{ runId: string }>;
};

export function createTaughtSkillEditor(
  botId: string,
  transport: TaughtSkillTransport,
  isCurrent: () => boolean,
  changed: () => void,
) {
  let skills: TaughtSkill[] = [];
  let verified = false;
  let busy = false;
  let error: unknown;
  let generation = 0;
  let active = false;
  let testRunId: string | null = null;
  const current = (epoch: number) => active && generation === epoch && isCurrent();
  const accept = (skill: TaughtSkill) => {
    if (skill.botId !== botId) throw new Error("Teaching target changed");
    skills = [skill, ...skills.filter((row) => row.id !== skill.id)];
  };
  async function read(epoch: number) {
    const rows = await transport.list();
    if (!current(epoch)) return;
    if (rows.some((row) => row.botId !== botId)) throw new Error("Teaching target changed");
    skills = rows;
    verified = true;
  }
  async function perform(action: (epoch: number) => Promise<void>) {
    if (busy || !active || !isCurrent()) return;
    const epoch = generation;
    busy = true;
    error = undefined;
    changed();
    try {
      await action(epoch);
    } catch (cause) {
      if (current(epoch)) error = cause;
    } finally {
      busy = false;
      if (active && isCurrent()) {
        changed();
        if (epoch !== generation) void refresh();
      }
    }
  }
  function refresh() {
    return perform(async (epoch) => {
      verified = false;
      changed();
      await read(epoch);
    });
  }
  return {
    isCurrent: () => active && isCurrent(),
    snapshot: () => ({ skills, verified, busy, error, testRunId }),
    setActive(value: boolean) {
      generation += 1;
      active = value;
      verified = false;
      if (value) void refresh();
    },
    refresh,
    start(goal: string) {
      if (
        !verified ||
        !goal.trim() ||
        skills.some((s) => ["recording", "drafting"].includes(s.status))
      )
        return Promise.resolve();
      return perform(async (epoch) => {
        // An uncertain response must require a successful status read before retry.
        verified = false;
        changed();
        const skill = await transport.start(goal.trim());
        if (!current(epoch)) return;
        accept(skill);
        await read(epoch);
      });
    },
    stop(skillId: string) {
      if (!verified || !skills.some((s) => s.id === skillId)) return Promise.resolve();
      return perform(async (epoch) => {
        verified = false;
        changed();
        const skill = await transport.stop(skillId);
        if (!current(epoch)) return;
        accept(skill);
        await read(epoch);
      });
    },
    submit(skillId: string, name: string, playbook: SkillPlaybook, mode: "save" | "test") {
      if (
        !verified ||
        !skills.some((s) => s.id === skillId && ["draft", "saved"].includes(s.status))
      )
        return Promise.resolve();
      const draft = { ...playbook, inputs: [...playbook.inputs], steps: [...playbook.steps] };
      return perform(async (epoch) => {
        const updated = await transport.update(skillId, name, draft);
        if (!current(epoch)) return;
        accept(updated);
        if (mode === "test") {
          const result = await transport.test(skillId);
          if (current(epoch)) testRunId = result.runId;
        } else {
          await transport.save(skillId, name);
          if (!current(epoch)) return;
          const saved = await transport.get(skillId);
          if (current(epoch)) accept(saved);
        }
      });
    },
  };
}
