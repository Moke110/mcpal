export function createStateExpressor<State>(output: () => ((state: State) => void) | undefined) {
  return (state: State): void => {
    output()?.(state);
  };
}
