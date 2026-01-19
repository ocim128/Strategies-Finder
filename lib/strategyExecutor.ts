
// Helper for safely executing dynamic strategy code
export class StrategyExecutor {
    private static readonly validateFnString = `
        "use strict"; 
        return function(data, params, indicators) { 
            return (function(data, params, indicators) {
                // User code text
                CODE_PLACEHOLDER
            })(data, params, indicators); 
        }`;

    /**
     * Tries to compile the code string into a runnable function.
     * Throws if syntax is invalid.
     */
    public static compile(code: string): void {
        const fullBody = this.validateFnString.replace('CODE_PLACEHOLDER', code);
        new Function(fullBody);
    }

    /**
     * Executes the strategy code.
     */
    public static execute(code: string, data: any[], params: any, indicators: any): any[] {
        const fullBody = this.validateFnString.replace('CODE_PLACEHOLDER', code);
        const fn = new Function(fullBody)();
        return fn(data, params, indicators);
    }
}
