import { z } from "zod";
import { ROLES } from "./scopes";

export const SignupInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(200),
  password: z.string().min(8).max(200),
  workspace_name: z.string().trim().min(1).max(120),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const Me = z.object({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string(), timezone: z.string() }),
  role: z.enum(ROLES),
});
export type Me = z.infer<typeof Me>;
