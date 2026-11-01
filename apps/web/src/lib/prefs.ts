"use client";

import type { Preferences } from "@ofertas/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

/** Cards (criativos) ligados nos envios? null enquanto carrega. Desligado = só a foto do produto. */
export function useCardsEnabled() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api<Preferences>("/workspace/preferences")
      .then((p) => setOn(p.creative_cards !== false))
      .catch(() => setOn(true));
  }, []);
  return on;
}
