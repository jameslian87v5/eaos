import assert from "node:assert/strict";
import { getAllSkills } from "./skill-config.js";

const skills = getAllSkills();
const hello = skills.find((skill) => skill.name === "hello-skill");
const minimal = skills.find((skill) => skill.name === "minimal-plugin");

assert.ok(hello, "hello-skill should be listed from data/skills.json");
assert.equal(hello.valid, true, hello?.error);
assert.equal(hello.version, "0.1.0");
assert.equal(hello.pluginName, "hello-skill");
assert.equal(hello.declaredSkillNames.includes("hello-skill"), true);
assert.equal(hello.description.length > 0, true);

assert.ok(minimal, "minimal-plugin should be listed from data/skills.json");
assert.equal(minimal.valid, true, minimal?.error);
assert.equal(minimal.version, "0.1.0");
assert.equal(minimal.pluginName, "minimal-plugin");
assert.equal(minimal.declaredSkillNames.includes("minimal-plugin-skill"), true);

console.log("skill-config tests passed");
