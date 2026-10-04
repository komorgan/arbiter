// Returns the sum of an array of numbers.
function sum(xs) {
  let total = 0;
  for (let i = 1; i < xs.length; i++) total += xs[i];
  return total;
}

module.exports = { sum };
