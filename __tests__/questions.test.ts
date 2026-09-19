/**
 * AI 提问（ask_user_question）答案组装测试
 *
 * 宿主的 matchesQuestions() 校验很严格，这里守住几条硬规则：
 *  · answers 与 questions 等长、id 对齐
 *  · 非 multiSelect 时 selected 至多一项
 *  · custom 与 selected 在单选下互斥（填了自定义答案就必须清空 selected）
 *  · custom 若存在必须非空
 */
import {
  buildQuestionAnswers,
  questionAnswered,
  setCustomDraft,
  toggleOptionDraft,
} from '../src/dsh/questions';
import type { QuestionDraft } from '../src/dsh/questions';
import type { AskUserQuestion } from '../src/dsh/types';

const single: AskUserQuestion = {
  id: 'q1',
  question: '用哪个方案？',
  options: [{ label: '方案A' }, { label: '方案B' }],
};
const multi: AskUserQuestion = {
  id: 'q2',
  question: '需要哪些能力？',
  multiSelect: true,
  options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
};

const empty: QuestionDraft = { selected: [], custom: '' };

describe('buildQuestionAnswers', () => {
  test('单选选中一项：selected 为该 label，且不带 custom', () => {
    const out = buildQuestionAnswers([single], { q1: { selected: ['方案A'], custom: '' } });
    expect(out).toEqual([{ id: 'q1', selected: ['方案A'] }]);
  });

  test('单选填自定义答案：selected 必须清空，只带 custom', () => {
    const out = buildQuestionAnswers([single], { q1: { selected: [], custom: '  用方案C  ' } });
    expect(out).toEqual([{ id: 'q1', selected: [], custom: '用方案C' }]);
  });

  test('单选即使残留 selected，只要有 custom 也必须清空（防宿主校验拒绝）', () => {
    const out = buildQuestionAnswers([single], { q1: { selected: ['方案A'], custom: '方案C' } });
    expect(out[0].selected).toEqual([]);
    expect(out[0].custom).toBe('方案C');
  });

  test('多选：selected 与 custom 可同时存在', () => {
    const out = buildQuestionAnswers([multi], { q2: { selected: ['甲', '丙'], custom: '丁' } });
    expect(out).toEqual([{ id: 'q2', selected: ['甲', '丙'], custom: '丁' }]);
  });

  test('多选纯选项、无 custom 时不带 custom 字段', () => {
    const out = buildQuestionAnswers([multi], { q2: { selected: ['乙'], custom: '   ' } });
    expect(out).toEqual([{ id: 'q2', selected: ['乙'] }]);
  });

  test('多题：等长且顺序与 id 对齐', () => {
    const out = buildQuestionAnswers([single, multi], {
      q1: { selected: ['方案B'], custom: '' },
      q2: { selected: ['甲'], custom: '' },
    });
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.id)).toEqual(['q1', 'q2']);
  });

  test('草稿缺失时给出空答案（仍保持等长）', () => {
    const out = buildQuestionAnswers([single, multi], {});
    expect(out).toEqual([
      { id: 'q1', selected: [] },
      { id: 'q2', selected: [] },
    ]);
  });
});

describe('questionAnswered', () => {
  test('全部未作答 -> false', () => {
    expect(questionAnswered([single, multi], { q1: empty, q2: empty })).toBe(false);
  });
  test('只有一题作答 -> false', () => {
    expect(questionAnswered([single, multi], { q1: { selected: ['方案A'], custom: '' }, q2: empty })).toBe(false);
  });
  test('都用自定义答案也算作答 -> true', () => {
    expect(
      questionAnswered([single, multi], {
        q1: { selected: [], custom: '随便' },
        q2: { selected: [], custom: '也行' },
      }),
    ).toBe(true);
  });
  test('空白自定义答案不算作答 -> false', () => {
    expect(questionAnswered([single], { q1: { selected: [], custom: '   ' } })).toBe(false);
  });
});

describe('草稿交互（互斥规则）', () => {
  test('单选：点选项后清空自定义答案', () => {
    const next = toggleOptionDraft(single, { selected: [], custom: '手输的' }, '方案A');
    expect(next).toEqual({ selected: ['方案A'], custom: '' });
  });
  test('单选：再点同一项取消选择', () => {
    const next = toggleOptionDraft(single, { selected: ['方案A'], custom: '' }, '方案A');
    expect(next).toEqual({ selected: [], custom: '' });
  });
  test('单选：点另一项替换而非叠加', () => {
    const next = toggleOptionDraft(single, { selected: ['方案A'], custom: '' }, '方案B');
    expect(next).toEqual({ selected: ['方案B'], custom: '' });
  });
  test('多选：叠加选择并保留自定义答案', () => {
    const next = toggleOptionDraft(multi, { selected: ['甲'], custom: '丁' }, '乙');
    expect(next).toEqual({ selected: ['甲', '乙'], custom: '丁' });
  });
  test('单选：输入自定义答案后清空已选项', () => {
    const next = setCustomDraft(single, { selected: ['方案A'], custom: '' }, '方案C');
    expect(next).toEqual({ selected: [], custom: '方案C' });
  });
  test('多选：输入自定义答案保留已选项', () => {
    const next = setCustomDraft(multi, { selected: ['甲'], custom: '' }, '丁');
    expect(next).toEqual({ selected: ['甲'], custom: '丁' });
  });
});
