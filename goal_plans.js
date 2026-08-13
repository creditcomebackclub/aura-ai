'use strict';

const crypto = require('crypto');

const MAX_PLAN_STEPS = 12;
const STEP_STATUSES = new Set(['pending', 'active', 'blocked', 'completed', 'dropped']);
const CLOSED_GOAL_STATUSES = new Set(['completed', 'cancelled', 'dropped']);

function cleanText(value, max = 1000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizedTitle(value) {
  return cleanText(value, 500).toLowerCase();
}

function goalTitle(goal) {
  return cleanText(goal?.description || goal?.title || 'Untitled', 1000) || 'Untitled';
}

function readGoalPlan(goal) {
  const raw = goal?.input?.goal_plan;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null;
  const steps = raw.steps
    .filter(step => step && typeof step === 'object' && cleanText(step.title, 500))
    .map((step, index) => ({
      id: cleanText(step.id, 80) || `legacy-step-${index + 1}`,
      title: cleanText(step.title, 500),
      status: STEP_STATUSES.has(step.status) ? step.status : 'pending',
      order: Number.isInteger(step.order) && step.order > 0 ? step.order : index + 1,
      due_at: step.due_at || null,
      created_at: step.created_at || raw.created_at || goal?.created_at || null,
      updated_at: step.updated_at || raw.updated_at || goal?.updated_at || null,
      completed_at: step.completed_at || null
    }))
    .sort((left, right) => left.order - right.order);
  return {
    version: 1,
    revision: Math.max(1, Number(raw.revision) || 1),
    desired_outcome: cleanText(raw.desired_outcome, 1200),
    steps,
    created_at: raw.created_at || goal?.created_at || null,
    updated_at: raw.updated_at || goal?.updated_at || null
  };
}

function mergeGoalPlan(goal, payload, {
  now = new Date(),
  idFactory = () => crypto.randomUUID()
} = {}) {
  const timestamp = now.toISOString();
  const previous = readGoalPlan(goal);
  const priorByTitle = new Map(
    (previous?.steps || []).map(step => [normalizedTitle(step.title), step])
  );
  const requestedKeys = new Set();
  const requested = payload.steps.slice(0, MAX_PLAN_STEPS).map((step, index) => {
    const title = cleanText(step.title, 500);
    const key = normalizedTitle(title);
    requestedKeys.add(key);
    const prior = priorByTitle.get(key);
    const revived = prior?.status === 'dropped';
    return {
      id: prior?.id || idFactory(),
      title,
      status: revived ? 'pending' : (prior?.status || 'pending'),
      order: index + 1,
      due_at: step.due_at === undefined ? (prior?.due_at || null) : (step.due_at || null),
      created_at: prior?.created_at || timestamp,
      updated_at: timestamp,
      completed_at: revived ? null : (prior?.completed_at || null)
    };
  });
  const retired = (previous?.steps || [])
    .filter(step => !requestedKeys.has(normalizedTitle(step.title)))
    .slice(0, MAX_PLAN_STEPS)
    .map((step, index) => ({
      ...step,
      status: 'dropped',
      order: requested.length + index + 1,
      updated_at: timestamp,
      completed_at: null
    }));
  const plan = {
    version: 1,
    revision: (previous?.revision || 0) + 1,
    desired_outcome: cleanText(payload.desired_outcome, 1200),
    steps: [...requested, ...retired],
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp
  };
  return {
    title: cleanText(payload.title, 1000),
    due_at: payload.due_at === undefined ? (goal?.due_at || null) : (payload.due_at || null),
    input: {
      ...(goal?.input && typeof goal.input === 'object' ? goal.input : {}),
      kind: 'goal_plan',
      goal_plan: plan
    },
    plan
  };
}

function updateGoalPlanStep(goal, stepId, status, { now = new Date() } = {}) {
  if (!STEP_STATUSES.has(status)) throw new Error(`Unsupported goal step status: ${status}`);
  const plan = readGoalPlan(goal);
  if (!plan) throw new Error('That goal does not have a plan yet.');
  const timestamp = now.toISOString();
  let found = false;
  const steps = plan.steps.map(step => {
    if (step.id !== stepId) return step;
    found = true;
    return {
      ...step,
      status,
      updated_at: timestamp,
      completed_at: status === 'completed' ? timestamp : null
    };
  });
  if (!found) throw new Error('Goal plan step not found.');
  const updatedPlan = {
    ...plan,
    revision: plan.revision + 1,
    steps,
    updated_at: timestamp
  };
  return {
    input: {
      ...(goal?.input && typeof goal.input === 'object' ? goal.input : {}),
      kind: 'goal_plan',
      goal_plan: updatedPlan
    },
    plan: updatedPlan
  };
}

function selectPlanNextAction(goal) {
  const plan = readGoalPlan(goal);
  if (!plan) {
    return {
      goal_id: String(goal?.id || ''),
      goal_title: goalTitle(goal),
      step_id: null,
      action: goalTitle(goal),
      status: 'pending',
      due_at: goal?.due_at || null,
      reason: 'This open goal does not have a step plan yet.'
    };
  }
  const open = plan.steps.filter(step => !['completed', 'dropped'].includes(step.status));
  if (!open.length) return null;
  const step = open.find(candidate => candidate.status === 'active') || open[0];
  const blocked = step.status === 'blocked';
  return {
    goal_id: String(goal?.id || ''),
    goal_title: goalTitle(goal),
    step_id: step.id,
    action: blocked ? `Unblock: ${step.title}` : step.title,
    status: step.status,
    due_at: step.due_at || goal?.due_at || null,
    reason: blocked
      ? 'The earliest remaining step is blocked.'
      : (step.status === 'active' ? 'This step is already in progress.' : 'This is the first unfinished plan step.')
  };
}

function summarizeGoal(goal) {
  const plan = readGoalPlan(goal);
  const visibleSteps = plan?.steps.filter(step => step.status !== 'dropped') || [];
  const completed = visibleSteps.filter(step => step.status === 'completed').length;
  return {
    id: goal?.id,
    title: goalTitle(goal),
    description: goal?.description || null,
    status: goal?.status || 'pending',
    priority: goal?.priority || 'normal',
    due_at: goal?.due_at || null,
    created_at: goal?.created_at || null,
    updated_at: goal?.updated_at || null,
    plan: plan ? {
      revision: plan.revision,
      desired_outcome: plan.desired_outcome,
      steps: visibleSteps,
      progress: {
        completed,
        total: visibleSteps.length,
        percent: visibleSteps.length ? Math.round((completed / visibleSteps.length) * 100) : 0
      },
      updated_at: plan.updated_at
    } : null,
    next_action: selectPlanNextAction(goal)
  };
}

function nextActionRank(goal, nextAction, nowMs) {
  const dueMs = Date.parse(nextAction?.due_at || goal?.due_at);
  const overdue = Number.isFinite(dueMs) && dueMs < nowMs;
  const dueBucket = overdue ? 0 : (Number.isFinite(dueMs) ? 1 : 2);
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 }[goal?.priority] ?? 2;
  const active = nextAction?.status === 'active' ? 0 : 1;
  const created = Date.parse(goal?.created_at);
  return [dueBucket, priority, Number.isFinite(dueMs) ? dueMs : Infinity, active, Number.isFinite(created) ? created : Infinity];
}

function compareRank(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function buildGoalPortfolio(goals, { now = new Date() } = {}) {
  const open = (Array.isArray(goals) ? goals : [])
    .filter(goal => goal && !CLOSED_GOAL_STATUSES.has(goal.status))
    .map(summarizeGoal);
  const candidates = open
    .filter(goal => goal.next_action)
    .map(goal => ({ goal, rank: nextActionRank(goal, goal.next_action, now.getTime()) }))
    .sort((left, right) => compareRank(left.rank, right.rank));
  const selected = candidates[0]?.goal?.next_action || null;
  if (selected) {
    const dueMs = Date.parse(selected.due_at);
    selected.portfolio_reason = Number.isFinite(dueMs) && dueMs < now.getTime()
      ? 'Selected because its goal or step is overdue.'
      : 'Selected from due date, priority, active state, and plan order.';
  }
  return { goals: open, next_action: selected };
}

module.exports = {
  CLOSED_GOAL_STATUSES,
  MAX_PLAN_STEPS,
  STEP_STATUSES,
  buildGoalPortfolio,
  goalTitle,
  mergeGoalPlan,
  readGoalPlan,
  selectPlanNextAction,
  summarizeGoal,
  updateGoalPlanStep
};
