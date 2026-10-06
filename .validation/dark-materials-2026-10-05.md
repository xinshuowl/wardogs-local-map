# 部分模型材质发黑：诊断与修复

## 已确认原因

1. `model-materials.js` 之前只要名称包含 Metal / Chrome 等关键词，就设置 0.72 金属度。三图的 `MI_MetalStallDesk_Tarp_01b`、`MI_PickUp_IZH_Atlas_Wood_Chrome` 因此也被当作裸金属；`MI_LC_Corrugated_Metal_WPO_01a` 未匹配原有的 Corrugated_WPO 排除规则。高金属度减少漫反射，在背光下更依赖环境反射。
2. `prop-view.js` 虽设置各材质 envMapIntensity，却未绑定 material.envMap。Three.js r180 在材质依赖 scene.environment 时，使用 scene.environmentIntensity 覆盖该 uniform。金属的 0.85、玻璃的 1.1 因此未实际生效；三图实际分别统一使用 0.245 / 0.35 / 0.35。
3. 另有近黑色替代材质，如 BlackUnlit、黑塑料，以及源颜色很深的轮胎等。这些不应全局提亮。未获得用户指出的具体模型坐标或截图，不能逐处断言黑色均由前两项引起。

## 修改

- 排除篷布、布料、木材、橡胶、塑料、涂层、玻璃等明确的非裸金属表面；混合木材/镀铬图集在缺少逐像素金属度数据时采用保守的非金属近似。
- 保留源 metalness / roughness / envMapIntensity 参数的优先级，包括显式零值。
- 所有模型材质显式共享同一张 PMREM 天空贴图，使用材质反射强度乘以对应地图 skyLightIntensity；没有复制环境贴图或新增每帧材质遍历。
- 覆盖材质先加载、天空后到达及材质后创建两种时序；环境变更时同步共享材质、补充预热，释放旧环境前解除材质引用。原模型常驻与 LOD 策略保持。

## 验证

- `node scripts/verify_lighting.mjs`：20 项通过。
- `node scripts/verify_model_loading.mjs`：通过，含失败重试和已显示实例保留。
- `node scripts/verify_terrain_loading.mjs`：16 项通过，含环境取消、失败和资源释放。
- `node scripts/verify_navigation_performance.mjs`：通过，含模型常驻、批处理、预热/取消和地图重置。
- 浏览器打开 `scripts/material-lighting-check.html`：PASS，无 console warning/error。调用实际 PropView、材质解析器、TerrainEnvironment 与三图贴图；关闭直射太阳以单独验证背光的环境照明，读取实际 GPU envMapIntensity uniform 和球体中心 64×64 区域像素亮度。
- 原 `scripts/lighting-preview.html` 复验：ready=true，玻璃后红柱、铁丝网孔洞、金属高光和贴花透明背景正常，无 console warning/error。

| 地图 | 篷布旧/新中心亮度 | 金属旧/新中心亮度 | 金属旧/新 GPU 反射强度 |
| --- | ---: | ---: | ---: |
| Bakurani | 50.15 / 92.47 | 50.14 / 85.64 | 0.245 / 0.595 |
| Ozeti | 68.95 / 119.57 | 68.94 / 111.31 | 0.35 / 0.85 |
| Zestafona | 67.30 / 117.07 | 36.53 / 65.97 | 0.35 / 0.85 |

亮度为 0–255 输出像素的加权平均，仅用于相同贴图和相机下的前后对照，不是物理照度，也不是对全图模型的逐面验收。新 GPU 强度均与预期一致。验收未修改正式地图坐标、武器、预设和个人标记。

## 边界

本轮解决已复现的分类与反射参数问题，没有恢复游戏原始完整 PBR、GI 或 AO。上一轮通用材质预览和源码数值测试没有覆盖“真实非金属材质误分类 + GPU 实际环境 uniform 被覆盖”的组合；本轮增加真实三图贴图对照。剩余个别黑块仍需依据模型位置区分源颜色、替代材质、法线或几何问题，不宣称全部黑色异常均已消除。
