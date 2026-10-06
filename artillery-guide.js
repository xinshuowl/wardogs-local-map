const steps = [
  ['武器选择', '.artillery-weapons', '选择 L81 迫击炮或 L52 加农炮。武器的有效射程、游戏刻度和弹道算法不同。'],
  ['设置炮位', '[data-art-point="0"]', '点击设置炮位，再在地形上选点；也可直接输入游戏 X / Y 坐标。3D 选点保留模型表面高度。'],
  ['设置目标', '[data-art-point="1"]', '设置目标后自动计算方位、距离和射击刻度。炮位与目标可拖动，缩放适配可同时查看两点。'],
  ['读取射击解', '#artillery-solution', '读取 mils、飞行时间与高差修正。两种弧线会分别检查建筑和地形；默认自动避开受阻弧线，手动选择后保持选择。'],
  ['观察员修正', '.artillery-correction-pad', '选择 10 / 25 / 50 / 100 米步长。Add / Drop 沿射向移动，Left / Right 垂直射向移动；应用到目标后保存新坐标。'],
  ['保存与瞄具', '#artillery-presets-form', '命名保存炮位和目标，或复制分享链接。Sight 打开动态绿色瞄具，⤢ 可放大；Fly / Walk 使用 WASD，Walk 使用空格跳跃。']
];

export class QuickGuide {
  constructor(panel) {
    this.panel = panel;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'quick-guide-dialog';
    this.dialog.innerHTML = '<span class="eyebrow" data-guide-count></span><h2></h2><p></p><footer><button data-guide-skip>跳过</button><button data-guide-back>上一步</button><button class="primary-button" data-guide-next>下一步</button></footer>';
    document.body.append(this.dialog);
    this.dialog.querySelector('[data-guide-skip]').addEventListener('click', () => this.close());
    this.dialog.querySelector('[data-guide-back]').addEventListener('click', () => { this.index--; this.render(); });
    this.dialog.querySelector('[data-guide-next]').addEventListener('click', () => { if (++this.index >= steps.length) this.close(); else this.render(); });
    this.dialog.addEventListener('cancel', () => this.close());
  }
  open() { this.previousFocus = document.activeElement; this.index = 0; this.dialog.showModal(); this.render(); }
  render() {
    this.highlight?.classList.remove('guide-highlight');
    const [title, selector, description] = steps[this.index];
    this.highlight = this.panel.querySelector(selector);
    this.highlight?.classList.add('guide-highlight');
    this.highlight?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.dialog.querySelector('[data-guide-count]').textContent = 'QUICK GUIDE · ' + (this.index + 1) + ' / ' + steps.length;
    this.dialog.querySelector('h2').textContent = title;
    this.dialog.querySelector('p').textContent = description;
    this.dialog.querySelector('[data-guide-back]').disabled = this.index === 0;
    this.dialog.querySelector('[data-guide-next]').textContent = this.index === steps.length - 1 ? '开始使用' : '下一步';
  }
  close() { this.highlight?.classList.remove('guide-highlight'); if (this.dialog.open) { this.dialog.close(); this.previousFocus?.focus(); } }
}

