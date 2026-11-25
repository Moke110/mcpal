export function createStateExpressor<State>(output: (state: State) => void, isAvailable = () => true) {
  return (state: State): void => {
    if (isAvailable()) output(state);
  };
}
