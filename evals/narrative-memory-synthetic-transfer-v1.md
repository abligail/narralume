# 合成作品迁移检查 v1

2026-10-13 根据用户“可以自己造”的授权创作。中文《雨夜档案馆》与英文《The Last Observatory Shift》各三章；第一章为历史，第二、三章为复盘目标。正文、角色、世界与真实六例无重合。它们是根据已经发现的失败类别设计的合成挑战，**不是盲测保留集，也不能证明真实长篇可靠性**。

数据沿用 `scripts/narrative-memory-semantic-eval.ts` 的生产复盘和规划入口，不新增执行器。每章保存 UTF-8 SHA-256、版本标识及 ParagraphLocator 的 UTF-16 引用位置。`source.database` 的 `synthetic-authored-no-database` 明确表示没有原数据库；不得将其包装成真实正文提取。

## 固定判定

两例都检查对象状态、时间更新、人物知识和已验证经验；中文还检查容器与内容数量、签收与未签申请的区别。具体 expected / forbidden / allowed 只存在 JSON 的 rubric 内，不进入生产 prompt。正文存在的猜测和未来提议保留其合法空间。未来章可以完成交接、到达、试验或披露，但不得把后续设计倒写成既往事实。

完整评分检查 observations、建议、故事线调整、rationale、continuityRisks、实体提案及章计划。引文逐字匹配只是来源校验，不能代替断言支持度判断。明确错记、必要事实未展示、合法未知和未来连续性缺口分别记录。沿用真实 v1 的整对判定；没有提到必要状态不计通过，也不自动称为幻觉。

本版在首轮模型执行前冻结正文与判据。后续不能为了通过率修改原文或标准；若判据发现错误，记录修订并另立版本。模型结果只能作为本合成挑战的观测，不能与真实 v1 的 18 组直接合并统计。

## 实际输入检查

首次 prepare-only 发现两例 planner 均只有第三章原文；review 拿到三章。原因是生产历史检索以指南针故事线作唯一查询，泛化承诺没有匹配历史人物名。该输入不能用于充分证据条件下的模型阅读评价。

生产查询加入已有实体目录的 name / aliases 后，第二次 prepare-only 的四份请求均逐段包含全部三章；作品语言、版本、hash 和 rubric 不泄漏检查通过。查询没有加入 rubric、验收答案或手工事实摘要。原查询版本的 prepared 产物保留用于输入缺口对照，不对其算语义分。

首次源码修正仅补检索词；实体没有覆盖所有历史事件，重名和常见名字也可能增加低相关片段。因此不宣称全作品召回已修复，正式执行仍须按实际请求逐段检查。实体目录与作者设定依旧不能证明事件发生或人物获知。

本地输入冻结和请求证据位于 `.tmp/memory-eval/synthetic-transfer-v1/input-freeze.json`，原查询和新查询请求分别在 `prepared/` 与 `with-entity-query/`。prepare-only 共八个阶段，实际模型调用为零。

进一步审阅后补齐 review 的显式实体检索、合法短名匹配、关键词与姓名片段预算顺序，以及段号定位、目录新鲜度与评测请求证据检查。全项目验证通过后，第三次 prepare-only 的四份请求仍逐段包含全部三章，rubric 未进入请求；固定 JSON 的 byte hash 保持 `62b0235d7679d3991d7ed4f31a7d6733ddb603ce83495dfbf40cd4a50f27b2d0`。本次请求及检查结果位于 `.tmp/memory-eval/synthetic-transfer-v1/reviewed-prepared/`，检查汇总为 `input-check.json`；三轮 prepare-only 合计十二个阶段，实际模型调用仍为零。进一步审阅的完整记录位于 `docs/internal/memory-review-fixes-2026-10-13.md`。

## 复现

使用已有环境模型配置：

```powershell
npm run eval:memory:semantic -- --dataset=evals/narrative-memory-synthetic-transfer-v1.json --protocol=openai-chat --repeats=3 --concurrency=2 --label=synthetic-transfer --output-dir=.tmp/memory-eval/synthetic-transfer-v1/production
```

执行前核对 dataset/profile/source/dist 身份，运行后按实际输入和输出评分。失败及重试保留成本，不通过换样本、换模型或选最好一次替代完整统计。
