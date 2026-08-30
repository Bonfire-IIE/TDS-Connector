/** 匿名接入状态严格限制为导航所需的一个布尔值。 */
export function publicOnboardingState(onboarded: boolean): { onboarded: boolean } {
  return { onboarded };
}
