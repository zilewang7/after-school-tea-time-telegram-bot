/**
 * Bot Response data model
 * Manages bot responses with version history and button states
 */
import {
    DataTypes,
    Model,
    InferAttributes,
    InferCreationAttributes,
} from '@sequelize/core';
import { sequelize } from './config';

/**
 * Button state for bot responses
 */
export enum ButtonState {
    /** No buttons (normal completion, single version) */
    NONE = 'none',
    /** Show stop button (streaming in progress) */
    PROCESSING = 'processing',
    /** Show retry button only (first stop/error) */
    RETRY_ONLY = 'retry_only',
    /** Has multiple versions, show [< retry >] */
    HAS_VERSIONS = 'has_versions',
    /** User edited message, show retry with special text */
    EDIT_DETECTED = 'edit_detected',
}

/**
 * Single version of a response
 */
export interface ResponseVersion {
    /** Version number, starting from 1 */
    versionId: number;
    /** ISO timestamp of creation */
    createdAt: string;
    /** All message IDs for this version */
    messageIds: number[];
    /** Current active message ID (where buttons are) */
    currentMessageId: number;
    /** Complete text content */
    text: string;
    /** Thinking content */
    thinkingText?: string;
    /** Grounding/search data */
    groundingData?: any[];
    /** Error message if any */
    errorMessage?: string;
    /** AI model raw response parts */
    modelParts?: any;
    /** Whether stopped by user */
    wasStoppedByUser: boolean;
    /** Image data as base64 (for version switching) */
    imageBase64?: string;
}

/**
 * Command type for bot responses
 */
export type CommandType = 'chat' | 'picbanana';

/**
 * Response metadata
 */
export interface ResponseMetadata {
    /** Model used for generation */
    model: string;
    /** Whether response contains images */
    hasImage: boolean;
    /** Command type that generated this response */
    commandType?: CommandType;
    /** Input token count */
    promptTokens?: number;
    /** Output token count */
    completionTokens?: number;
}

/**
 * Bot Response model
 */
export class BotResponse extends Model<
    InferAttributes<BotResponse>,
    InferCreationAttributes<BotResponse>
> {
    /** Primary key: first message ID */
    declare messageId: number;

    /** Chat ID */
    declare chatId: number;

    /** User message ID that this response replies to */
    declare userMessageId: number;

    /** Current version index being displayed */
    declare currentVersionIndex: number;

    /** All versions (JSON: ResponseVersion[]) */
    declare versions: string;

    /** Current button state */
    declare buttonState: ButtonState;

    /** Metadata (JSON: ResponseMetadata) */
    declare metadata: string;

    /** Created timestamp */
    declare createdAt?: Date;

    /** Updated timestamp */
    declare updatedAt?: Date;

    /**
     * Get parsed versions array
     */
    getVersions(): ResponseVersion[] {
        try {
            return JSON.parse(this.versions || '[]');
        } catch {
            return [];
        }
    }

    /**
     * Set versions array
     */
    setVersions(versions: ResponseVersion[]): void {
        this.versions = JSON.stringify(versions);
    }

    /**
     * Get current version
     */
    getCurrentVersion(): ResponseVersion | null {
        const versions = this.getVersions();
        return versions[this.currentVersionIndex] ?? null;
    }

    /**
     * Add a new version
     */
    addVersion(version: ResponseVersion): void {
        const versions = this.getVersions();
        versions.push(version);
        this.setVersions(versions);
        this.currentVersionIndex = versions.length - 1;
    }

    /**
     * Get parsed metadata
     */
    getMetadata(): ResponseMetadata {
        try {
            return JSON.parse(this.metadata || '{}');
        } catch {
            return { model: 'unknown', hasImage: false };
        }
    }

    /**
     * Set metadata
     */
    setMetadata(metadata: ResponseMetadata): void {
        this.metadata = JSON.stringify(metadata);
    }

    /**
     * Check if this response has multiple versions
     */
    hasMultipleVersions(): boolean {
        return this.getVersions().length > 1;
    }

    /**
     * Check if can switch to previous version
     */
    canSwitchPrev(): boolean {
        return this.currentVersionIndex > 0;
    }

    /**
     * Check if can switch to next version
     */
    canSwitchNext(): boolean {
        const versions = this.getVersions();
        return this.currentVersionIndex < versions.length - 1;
    }
}

BotResponse.init(
    {
        messageId: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            allowNull: false,
        },
        chatId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        userMessageId: {
            type: DataTypes.INTEGER,
            allowNull: false,
        },
        currentVersionIndex: {
            type: DataTypes.INTEGER,
            defaultValue: 0,
            allowNull: false,
        },
        versions: {
            type: DataTypes.JSON,
            defaultValue: '[]',
            allowNull: false,
        },
        buttonState: {
            type: DataTypes.STRING,
            defaultValue: ButtonState.NONE,
            allowNull: false,
        },
        metadata: {
            type: DataTypes.JSON,
            defaultValue: '{}',
            allowNull: false,
        },
        createdAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
            allowNull: false,
        },
        updatedAt: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
            allowNull: false,
        },
    },
    {
        sequelize,
        tableName: 'bot_responses',
        timestamps: true,
        indexes: [
            { fields: ['chatId', 'userMessageId'] },
            { fields: ['chatId', 'messageId'] },
        ],
    }
);
