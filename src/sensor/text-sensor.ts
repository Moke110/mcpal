type TextSource = "gui" | "voice";

export function createTextSensor(submit: (text: string, source: TextSource) => number | null) {
  return (input: unknown, source: unknown): number | null => {
    if (typeof input !== "string" || (source !== "gui" && source !== "voice")) {
      throw new TypeError("Invalid desktop input");
    }
    return submit(input, source);
  };
}
