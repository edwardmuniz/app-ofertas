import { describe, expect, it } from "vitest";
import { presignS3Url, s3ConfigFromEnv } from "../src/storage-s3";

describe("S3", () => {
  it("assina a URL igual ao exemplo da documentação da AWS", () => {
    const url = presignS3Url({
      method: "GET",
      bucket: "examplebucket",
      region: "us-east-1",
      key: "test.txt",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expiresSeconds: 86_400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?")).toBe(true);
    expect(url).toContain(
      "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("usa o host da região e o estilo de caminho para bucket com ponto", () => {
    const base = {
      method: "GET" as const,
      region: "us-east-2",
      key: "ws/a b.png",
      accessKeyId: "K",
      secretAccessKey: "S",
      expiresSeconds: 60,
    };
    expect(presignS3Url({ ...base, bucket: "b" })).toMatch(
      /^https:\/\/b\.s3\.us-east-2\.amazonaws\.com\/ws\/a%20b\.png\?/,
    );
    expect(presignS3Url({ ...base, bucket: "a.b" })).toMatch(
      /^https:\/\/s3\.us-east-2\.amazonaws\.com\/a\.b\/ws\/a%20b\.png\?/,
    );
  });

  it("só liga o S3 com as três variáveis", () => {
    expect(s3ConfigFromEnv({ AWS_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "k" })).toBeNull();
    expect(
      s3ConfigFromEnv({ AWS_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" }),
    ).toMatchObject({ bucket: "b", region: undefined });
  });
});
