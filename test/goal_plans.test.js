'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildGoalPortfolio,
  mergeGoalPlan,
  readGoalPlan,
  selectPlanNextAction,
  updateGoalPlanStep
} = require('../goal_plans');

const NOW = new Date('2026-08-13T17:00:00.000Z');

function plannedGoal(overrides = {}) {
  const ids = ['step-1', 'step-2', 'step-3'];
  const merged = mergeGoalPlan({ id: 'goal-1', input: {} }, {
    title: 'Launch the new offer',
    desired_outcome: 'First ten customers are successfully onboarded.',
    due_at: '2026-09-01T00:00:00.000Z',
    steps: [
      { title: 'Define the offer' },
      { title: 'Build the landing page' },
      { title: 'Invite the first prospects' }
    ]
  }, { now: NOW, idFactory: () => ids.shift() });
  return {
    id: 'goal-1',
    title: merged.title,
    status: 'running',
    priority: 'high',
    due_at: merged.due_at,
    created_at: '2026-08-10T00:00:00.000Z',
    input: merged.input,
    ...overrides
  };
}

test('a goal plan is durable, ordered, and produces one next action', () => {
  const goal = plannedGoal();
  const plan = readGoalPlan(goal);

  assert.equal(plan.revision, 1);
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map(step => step.order), [1, 2, 3]);
  assert.deepEqual(selectPlanNextAction(goal), {
    goal_id: 'goal-1',
    goal_title: 'Launch the new offer',
    step_id: 'step-1',
    action: 'Define the offer',
    status: 'pending',
    due_at: '2026-09-01T00:00:00.000Z',
    reason: 'This is the first unfinished plan step.'
  });
});

test('revising a plan preserves matching progress and retires removed steps', () => {
  let goal = plannedGoal();
  goal = { ...goal, ...updateGoalPlanStep(goal, 'step-1', 'completed', { now: new Date(NOW.getTime() + 1000) }) };
  const revised = mergeGoalPlan(goal, {
    title: 'Launch the new offer',
    desired_outcome: 'First ten paying customers are successfully onboarded.',
    steps: [
      { title: 'Define the offer' },
      { title: 'Interview five prospects' },
      { title: 'Invite the first prospects' }
    ]
  }, {
    now: new Date(NOW.getTime() + 2000),
    idFactory: () => 'step-new'
  });

  const plan = revised.plan;
  assert.equal(plan.revision, 3);
  assert.equal(plan.steps.find(step => step.id === 'step-1').status, 'completed');
  assert.equal(plan.steps.find(step => step.title === 'Interview five prospects').id, 'step-new');
  assert.equal(plan.steps.find(step => step.title === 'Build the landing page').status, 'dropped');
  assert.equal(plan.steps.find(step => step.id === 'step-3').id, 'step-3');
});

test('step updates prefer active work and surface blockers instead of skipping them', () => {
  let goal = plannedGoal();
  goal = { ...goal, ...updateGoalPlanStep(goal, 'step-2', 'active', { now: NOW }) };
  assert.equal(selectPlanNextAction(goal).step_id, 'step-2');
  assert.equal(selectPlanNextAction(goal).reason, 'This step is already in progress.');

  goal = { ...goal, ...updateGoalPlanStep(goal, 'step-2', 'completed', { now: NOW }) };
  goal = { ...goal, ...updateGoalPlanStep(goal, 'step-1', 'blocked', { now: NOW }) };
  assert.equal(selectPlanNextAction(goal).action, 'Unblock: Define the offer');
  assert.equal(selectPlanNextAction(goal).reason, 'The earliest remaining step is blocked.');
});

test('portfolio selection is deterministic across due dates and priority', () => {
  const future = plannedGoal();
  const overdue = {
    id: 'goal-2',
    title: 'File the response',
    status: 'pending',
    priority: 'normal',
    due_at: '2026-08-12T17:00:00.000Z',
    created_at: '2026-08-11T00:00:00.000Z',
    input: {}
  };
  const portfolio = buildGoalPortfolio([future, overdue], { now: NOW });

  assert.equal(portfolio.goals.length, 2);
  assert.equal(portfolio.next_action.goal_id, 'goal-2');
  assert.equal(portfolio.next_action.action, 'File the response');
  assert.match(portfolio.next_action.portfolio_reason, /overdue/);
});
