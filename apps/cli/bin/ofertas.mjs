#!/usr/bin/env node
// Executa a CLI em TypeScript via tsx.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
