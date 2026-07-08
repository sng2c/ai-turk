import * as React from "react";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import {
	Card as ShadcnCard,
	CardContent as ShadcnCardContent,
	CardHeader as ShadcnCardHeader,
	CardTitle as ShadcnCardTitle,
} from "@/components/ui/card";
import "@/components/ui/pixelact-ui/styles/styles.css";

export const cardVariants = cva("", {
	variants: {
		font: { normal: "", pixel: "pixel-font" },
	},
	defaultVariants: { font: "pixel" },
});

export interface CardProps
	extends React.ComponentProps<"div">,
		VariantProps<typeof cardVariants> {
	asChild?: boolean;
}

function Card({ ...props }: CardProps) {
	const { className, font } = props;
	return (
		<ShadcnCard
			{...props}
			className={cn(
				"rounded-none border-0 bg-card shadow-(--pixel-box-shadow) box-shadow-margin",
				cardVariants({ font }),
				className
			)}
		/>
	);
}

function CardHeader({ ...props }: CardProps) {
	return <ShadcnCardHeader className={cn("", props.className)} {...props} />;
}

function CardTitle({ ...props }: CardProps) {
	return <ShadcnCardTitle className={cn("font-normal text-lg", props.className)} {...props} />;
}

function CardContent({ ...props }: CardProps) {
	return <ShadcnCardContent className={cn(props.className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardContent };