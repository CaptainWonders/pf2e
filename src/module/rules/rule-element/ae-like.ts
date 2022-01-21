import { FeatPF2e, ItemPF2e } from "@item";
import { isObject } from "@util";
import { RuleElementPF2e, RuleElementSource, RuleElementData, RuleValue } from "./";

/**
 * Make a numeric modification to an arbitrary property in a similar way as `ActiveEffect`s
 * @category RuleElement
 */
class AELikeRuleElement extends RuleElementPF2e {
    static CHANGE_MODES = ["multiply", "add", "downgrade", "upgrade", "override"];

    constructor(data: AELikeSource, item: Embedded<ItemPF2e>) {
        data = deepClone(data);
        data.priority ??=
            typeof data.mode === "string" && AELikeRuleElement.CHANGE_MODES.includes(data.mode)
                ? AELikeRuleElement.CHANGE_MODES.indexOf(data.mode) * 10 + 10
                : NaN;
        data.phase ??= "applyAEs";

        super(data, item);

        if (Number.isNaN(this.priority)) {
            this.ignored = true;
            return;
        }

        // Validate data properties
        const actor = item.actor;
        const pathIsValid =
            typeof this.path === "string" &&
            [this.path, this.path.replace(/\.\w+$/, ""), this.path.replace(/\.?\w+\.\w+$/, "")].some(
                (path) => typeof getProperty(actor.data, path) !== undefined
            );
        if (!pathIsValid) this.warn("path");

        const valueIsValid = ["number", "string", "boolean", "object"].includes(typeof this.value);
        if (!valueIsValid) this.warn("value");

        if (!(pathIsValid && valueIsValid)) {
            this.ignored = true;
            return;
        }
    }

    get path(): string {
        return this.data.path;
    }

    get mode(): AELikeChangeMode {
        return this.data.mode;
    }

    get value(): RuleValue {
        return this.data.value;
    }

    /** Apply the modifications immediately after proper ActiveEffects are applied */
    override onApplyActiveEffects(): void {
        if (!this.ignored && this.data.phase === "applyAEs") this.applyAELike();
    }

    /** Apply the modifications near the beginning of the actor's derived-data preparation */
    override beforePrepareData(): void {
        if (!this.ignored && this.data.phase === "beforeDerived") this.applyAELike();
    }

    /** Apply the modifications at the conclusion of the actor's derived-data preparation */
    override afterPrepareData(): void {
        if (!this.ignored && this.data.phase === "afterDerived") this.applyAELike();
    }

    private applyAELike(): void {
        // Test predicate if present. AE-Like predicates are severely limited: at their default phase, they can only be
        // tested against roll options set by `ItemPF2e#prepareActorData` and higher-priority AE-Likes.
        const { predicate } = this.data;
        if (predicate && !predicate.test(this.actor.getRollOptions(["all"]))) {
            return;
        }

        this.data.path = this.resolveInjectedProperties(this.data.path);
        // Do not proceed if injected-property resolution failed
        if (/\bundefined\b/.test(this.path)) return;

        const change: unknown = this.resolveValue(this.data.value);
        const current: unknown = getProperty(this.actor.data, this.path);

        switch (this.mode) {
            case "multiply": {
                if (!(typeof change === "number" && (typeof current === "number" || current === undefined))) {
                    return this.warn("path");
                }
                const newValue = (current ?? 0) * change;
                setProperty(this.actor.data, this.path, newValue);
                this.logChange(change);
                break;
            }
            case "add": {
                // A numeric add is valid if the change value is a number and the current value is a number or nullish
                const isNumericAdd =
                    typeof change === "number" &&
                    (typeof current === "number" || current === undefined || current === null);
                // An array add is valid if the current value is an array and either empty or consisting of all elements
                // of the same type as the change value
                const isArrayAdd = Array.isArray(current) && current.every((e) => typeof e === typeof change);

                if (isNumericAdd) {
                    const newValue = (current ?? 0) + change;
                    setProperty(this.actor.data, this.path, newValue);
                    this.logChange(change);
                } else if (isArrayAdd) {
                    current.push(change);
                } else {
                    this.warn("path");
                }
                break;
            }
            case "downgrade": {
                if (!(typeof change === "number" && (typeof current === "number" || current === undefined))) {
                    return this.warn("path");
                }
                const newValue = Math.min(current ?? 0, change);
                setProperty(this.actor.data, this.path, newValue);
                this.logChange(change);
                break;
            }
            case "upgrade": {
                if (!(typeof change === "number" && (typeof current === "number" || current === undefined))) {
                    return this.warn("path");
                }
                const newValue = Math.max(current ?? 0, change);
                setProperty(this.actor.data, this.path, newValue);
                this.logChange(change);
                break;
            }
            case "override": {
                const currentValue = getProperty(this.actor.data, this.path);
                if (typeof change === typeof currentValue || currentValue === undefined) {
                    // Resolve all values if the override is an object
                    if (isObject<Record<string, unknown>>(change)) {
                        for (const [key, value] of Object.entries(change)) {
                            if (typeof value === "string") change[key] = this.resolveInjectedProperties(value);
                        }
                    }
                    setProperty(this.actor.data, this.path, change);
                    if (typeof change === "string") this.logChange(change);
                }
            }
        }
    }

    /** Log the numeric change of an actor data property */
    private logChange(value: string | number): void {
        const { item, mode } = this;
        if (typeof value === "string" && mode !== "override") return;

        const level =
            item instanceof FeatPF2e
                ? Number(/-(\d+)$/.exec(item.data.data.location ?? "")?.[1]) || item.level
                : "level" in item && typeof item["level"] === "number"
                ? item["level"]
                : null;
        const { autoChanges } = this.actor.data.data;
        const entries = (autoChanges[this.path] ??= []);
        entries.push({ mode, level, value, source: this.item.name });
    }

    private warn(path: string): void {
        const item = this.item;
        console.warn(
            `PF2e System | "${path}" property on RuleElement from item ${item.name} (${item.uuid}) is invalid`
        );
    }
}

export interface AutoChangeEntry {
    source: string;
    level: number | null;
    value: number | string;
    mode: AELikeChangeMode;
}

interface AELikeRuleElement extends RuleElementPF2e {
    data: AELikeData;
}

type AELikeChangeMode = "add" | "multiply" | "upgrade" | "downgrade" | "override";

export interface AELikeData extends RuleElementData {
    path: string;
    value: RuleValue;
    mode: AELikeChangeMode;
    priority: number;
    phase: "applyAEs" | "beforeDerived" | "afterDerived";
}

export interface AELikeSource extends RuleElementSource {
    mode?: unknown;
    path?: unknown;
    phase?: "applyAEs" | "beforeDerived" | "afterDerived";
}

export { AELikeRuleElement };
