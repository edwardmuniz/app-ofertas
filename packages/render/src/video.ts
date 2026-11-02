// Leitura mínima de MP4 (ISO BMFF): dimensões e duração, sem ffmpeg.

export type VideoMeta = {
  mime: "video/mp4";
  width: number;
  height: number;
  seconds: number;
  /** Formato da faixa de vídeo: avc1/avc3 = H.264; hvc1/hev1 = HEVC. null se não achou. */
  codec: string | null;
};

type Box = { type: string; start: number; end: number };

function boxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}

const child = (buf: Buffer, parent: Box, type: string) =>
  boxes(buf, parent.start, parent.end).filter((b) => b.type === type);

/** Dimensões (da faixa de vídeo) e duração de um MP4. null se não for MP4 legível. */
export function inspectVideo(buf: Buffer): VideoMeta | null {
  if (buf.length < 16 || buf.toString("latin1", 4, 8) !== "ftyp") return null;
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === "moov");
  if (!moov) return null;
  const mvhd = child(buf, moov, "mvhd")[0];
  if (!mvhd) return null;
  const v1 = buf[mvhd.start] === 1;
  const timescale = buf.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
  const duration = v1
    ? Number(buf.readBigUInt64BE(mvhd.start + 24))
    : buf.readUInt32BE(mvhd.start + 16);
  if (!timescale) return null;
  for (const trak of child(buf, moov, "trak")) {
    const tkhd = child(buf, trak, "tkhd")[0];
    if (!tkhd) continue;
    const t1 = buf[tkhd.start] === 1;
    // versão + flags, datas, track id, reservado, duração, reservado, camada, grupo, volume, reservado, matriz
    const at = tkhd.start + (t1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4) + 8 + 8 + 36;
    if (at + 8 > tkhd.end) continue;
    const width = buf.readUInt32BE(at) >>> 16;
    const height = buf.readUInt32BE(at + 4) >>> 16;
    if (width > 0 && height > 0) {
      return {
        mime: "video/mp4",
        width,
        height,
        seconds: Math.round((duration / timescale) * 10) / 10,
        codec: codecOf(buf, trak),
      };
    }
  }
  return null;
}

function codecOf(buf: Buffer, trak: Box): string | null {
  let box: Box | undefined = trak;
  for (const type of ["mdia", "minf", "stbl", "stsd"]) {
    box = box ? child(buf, box, type)[0] : undefined;
  }
  // stsd: versão + flags (4), quantidade (4), primeira entrada: tamanho (4) e tipo (4).
  if (!box || box.start + 16 > box.end) return null;
  return buf.toString("latin1", box.start + 12, box.start + 16);
}
