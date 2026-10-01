/**
 * Calibración de entrada aplicada una sola vez en el backend.
 * El desplazamiento de POS es independiente de DIST y del encoder.
 * Los valores ausentes no se convierten en cero ni en detecciones válidas.
 */
// Installation calibration: 6.3 cm reported by the ESP corresponds to 10 cm
// physically. Apply only at ESP ingress; browser parsing and snapshots already
// contain calibrated POS. DIST and encoder measurements retain their units.
export const POS_OFFSET_CM=10-6.3;

export function calibrateTelemetry(raw){
  if(!raw)return null;
  const pos=Number.isFinite(raw.pos)&&raw.pos>=0?raw.pos+POS_OFFSET_CM:null;
  return {...raw,pos};
}
