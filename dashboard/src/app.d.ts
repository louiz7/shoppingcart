declare global {
	namespace App {
		interface Locals {
			user: {
				id: number;
				customerId: number;
				email: string;
				displayName: string;
				role: 'admin' | 'operator' | 'viewer';
				emailAutomationEnabled: boolean;
				isRescovaAdminOrganization: boolean;
			} | null;
		}
		interface PageData {
			user: Locals['user'];
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
