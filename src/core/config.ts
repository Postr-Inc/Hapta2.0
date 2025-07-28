// src/core/config.ts
import fs from 'fs';
import path from 'path';
import os from 'os';

// Define the shape of your configuration
export interface AppConfig {
    port: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    // Add other configuration properties here
    origin: string,
    AI_ENABLED: boolean,
    Clover_Tenant_ID: string, 
    Clover_Secret: string,
    Clover_Server_Url: string,
    NodeId: string,
    JWT_SECRET: String,
    ADMIN_EMAIL: string,
    ADMIN_PASSWORD: string,
    DatabaseUrl:string,
}

// Define your default configuration as a fallback
const defaultConfig: AppConfig = {
    port: 8080,
    logLevel: 'info',
};

function findAndLoadConfig(): AppConfig {
    // 1. Look for 'hapta.config.json' in the current directory
    const localConfigPath = path.join(process.cwd(), 'hapta.config.json');

    // Add other locations to check here if you want (e.g., home directory)

    try {
        if (fs.existsSync(localConfigPath)) {
            console.log(`Loading configuration from: ${localConfigPath}`);
            const fileContent = fs.readFileSync(localConfigPath, 'utf-8');
            const userConfig = JSON.parse(fileContent);
            console.log(userConfig)
            
            // Merge user config with defaults, so user only has to specify what they want to change
            return { ...defaultConfig, ...userConfig };
        }
    } catch (error) {
        console.error('Error reading or parsing config file:', error);
        // Fallback to defaults if the file is malformed
        return defaultConfig;
    }

    // 2. If no file is found, return the default configuration
    console.log('No hapta.config.json found. Using default settings.');
    return defaultConfig;
}

// Load the config once and export it for the rest of the app to use
export const config = findAndLoadConfig();