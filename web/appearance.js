export const palettes = {
  green: { label: 'Vert', light: ['#287354','#e3eee5','#cedfd2','#f0f4ef'], dark: ['#a7dfb6','#304b39','#3b6047','#17201b'] },
  blue: { label: 'Bleu', light: ['#285f91','#e4eef8','#ccdfef','#eff3f7'], dark: ['#afd3f6','#2b4055','#355873','#17212c'] },
  orange: { label: 'Orange', light: ['#984611','#fbecdf','#f2d8c2','#f8f3ee'], dark: ['#ffc595','#533a27','#704b2d','#271e18'] },
  brown: { label: 'Brun', light: ['#79543b','#f0e7de','#e4d4c4','#f5f1ec'], dark: ['#e3c3a7','#453a30','#5a493a','#241e19'] },
};
export function readAppearance(storage) {
  try {
    return { theme: storage.getItem('hermitage-theme') === 'dark' ? 'dark' : 'light',
      palette: Object.hasOwn(palettes, storage.getItem('hermitage-palette')) ? storage.getItem('hermitage-palette') : 'green',
      tint: storage.getItem('hermitage-tint') === 'strong' ? 'strong' : 'soft' };
  } catch { return { theme: 'light', palette: 'green', tint: 'soft' }; }
}
export function appearanceTokens({theme, palette, tint}) {
  const [accent, soft, strong, bg] = palettes[palette][theme];
  return { '--accent':accent, '--soft':soft, '--form-tint':tint === 'strong' ? strong : soft, '--bg':bg };
}
