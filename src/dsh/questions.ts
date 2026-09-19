// questions.ts — AI 提问（ask_user_question）的答案组装与校验逻辑
//
// 宿主的 matchesQuestions() 会严格校验答案，规则：
//  · answers 必须与 questions 等长、逐项 id 对齐
//  · selected 内不得重复，且每个 label 必须来自该题的 options
//  · custom 若存在必须非空（trim 后）
//  · 非 multiSelect 的题：最多选 1 项，且 custom 与 selected 互斥（不能同时有值）
// 因此「单选 + 填了自定义答案」时必须把 selected 清空。

import type { AskUserQuestion, AskUserQuestionAnswerItem } from './types';

/** 每题本地的作答草稿 */
export interface QuestionDraft {
  selected: string[];
  custom: string;
}

/** 按宿主规则组装整批答案 */
export function buildQuestionAnswers(
  questions: AskUserQuestion[],
  drafts: Record<string, QuestionDraft>,
): AskUserQuestionAnswerItem[] {
  return questions.map((q) => {
    const draft = drafts[q.id] ?? { selected: [], custom: '' };
    const custom = draft.custom.trim();
    return {
      id: q.id,
      selected: custom === '' || q.multiSelect === true ? draft.selected : [],
      ...(custom === '' ? {} : { custom }),
    };
  });
}

/** 每题都要「选了选项」或「填了自定义答案」才允许提交 */
export function questionAnswered(
  questions: AskUserQuestion[],
  drafts: Record<string, QuestionDraft>,
): boolean {
  return questions.every((q) => {
    const draft = drafts[q.id];
    if (!draft) return false;
    return draft.selected.length > 0 || draft.custom.trim() !== '';
  });
}

/** 点击一个选项后的新草稿（单选互斥；单选下选了选项即清空自定义答案） */
export function toggleOptionDraft(
  question: AskUserQuestion,
  draft: QuestionDraft,
  label: string,
): QuestionDraft {
  const isMulti = question.multiSelect === true;
  const has = draft.selected.includes(label);
  const selected = isMulti
    ? has
      ? draft.selected.filter((l) => l !== label)
      : [...draft.selected, label]
    : has
      ? []
      : [label];
  return { selected, custom: isMulti ? draft.custom : '' };
}

/** 编辑自定义答案后的新草稿（单选下输入自定义答案即清空已选项） */
export function setCustomDraft(question: AskUserQuestion, draft: QuestionDraft, text: string): QuestionDraft {
  return {
    selected: question.multiSelect === true ? draft.selected : [],
    custom: text,
  };
}
