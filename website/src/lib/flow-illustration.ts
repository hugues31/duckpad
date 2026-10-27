export interface Card {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
}

export const cards: Card[] = [
  { x: 24, y: 94, width: 184, height: 76, angle: -5 },
  { x: 264, y: 109, width: 198, height: 76, angle: 5 },
  { x: 122, y: 278, width: 260, height: 78, angle: 0 },
  { x: 147, y: 400, width: 220, height: 42, angle: -3 },
];

const motion = [
  { period: 13, phase: 0.2, x: 4, y: 5, angle: 1.6 },
  { period: 17, phase: 2.1, x: 5, y: 4, angle: 1.9 },
  { period: 19, phase: 4.2, x: 3, y: 4, angle: 1.1 },
  { period: 15, phase: 5.4, x: 4, y: 3, angle: 1.4 },
];

export function animatedCards(seconds: number): Card[] {
  return cards.map((card, index) => {
    const drift = motion[index];
    const phase = (seconds * 2 * Math.PI) / drift.period + drift.phase;
    // Start at the static pose and keep each trajectory smooth across cycles.
    return {
      ...card,
      x: card.x + drift.x * (Math.sin(phase) - Math.sin(drift.phase)),
      y: card.y + drift.y * (Math.cos(phase) - Math.cos(drift.phase)),
      angle:
        card.angle +
        drift.angle * (Math.sin(phase + 1) - Math.sin(drift.phase + 1)),
    };
  });
}

export const transform = (card: Card) =>
  `translate(${card.x} ${card.y}) rotate(${card.angle} ${card.width / 2} ${card.height / 2})`;

function socket(card: Card, x: number, y: number) {
  const angle = (card.angle * Math.PI) / 180;
  const dx = x - card.width / 2;
  const dy = y - card.height / 2;
  return {
    x: card.x + card.width / 2 + dx * Math.cos(angle) - dy * Math.sin(angle),
    y: card.y + card.height / 2 + dx * Math.sin(angle) + dy * Math.cos(angle),
  };
}
function connect(
  from: ReturnType<typeof socket>,
  to: ReturnType<typeof socket>,
) {
  const middle = (from.y + to.y) / 2;
  return `M${from.x} ${from.y} C${from.x} ${middle} ${to.x} ${middle} ${to.x} ${to.y}`;
}
export function connectionsFor([orders, customers, aggregate, report]: Card[]) {
  return [
    connect(
      socket(orders, orders.width / 2, orders.height),
      socket(aggregate, 65, 0),
    ),
    connect(
      socket(customers, customers.width / 2, customers.height),
      socket(aggregate, 195, 0),
    ),
    connect(
      socket(aggregate, aggregate.width / 2, aggregate.height),
      socket(report, report.width / 2, 0),
    ),
  ].join(" ");
}
