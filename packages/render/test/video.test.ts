import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectVideo } from "../src";

const fixture = readFileSync(join(__dirname, "fixtures", "vertical-6s.mp4"));

describe("inspectVideo", () => {
  it("lê dimensões e duração de um MP4", () => {
    expect(inspectVideo(fixture)).toEqual({
      mime: "video/mp4",
      width: 1080,
      height: 1920,
      seconds: 6,
      codec: "avc1",
    });
  });

  it("lê MP4 com o índice no começo (faststart)", () => {
    const h = readFileSync(join(__dirname, "fixtures", "horizontal-6s.mp4"));
    expect(inspectVideo(h)).toMatchObject({ width: 640, height: 360, seconds: 6 });
  });

  it("recusa o que não é MP4", () => {
    expect(inspectVideo(Buffer.from("não sou vídeo, só texto comprido o bastante"))).toBeNull();
    expect(inspectVideo(fixture.subarray(0, 40))).toBeNull();
  });
});
