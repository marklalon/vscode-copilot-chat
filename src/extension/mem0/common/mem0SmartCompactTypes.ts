/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatEndpoint } from '../../../platform/networking/common/networking';
import { createServiceIdentifier } from '../../../util/common/services';

export interface IMem0SmartCompactResolution {
	readonly endpoint: IChatEndpoint;
	readonly details?: string;
}

export interface IMem0SmartCompactService {
	readonly _serviceBrand: undefined;

	resolveCompactEndpoint(baseEndpoint: IChatEndpoint): Promise<IMem0SmartCompactResolution>;
}

export const IMem0SmartCompactService = createServiceIdentifier<IMem0SmartCompactService>('IMem0SmartCompactService');